import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.mjs';

const DEFAULT_MEMORY_FILE = path.resolve(process.cwd(), 'data', 'memories.json');
const VALID_TYPES = new Set(['preference', 'project', 'decision', 'fact']);

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? Math.max(0, dot / denom) : 0;
}

export async function generateMemoryEmbedding(text = '', {
  apiKey = config.geminiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000
} = {}) {
  const clean = String(text || '').trim();
  if (!clean || !apiKey || typeof fetchImpl !== 'function') return null;
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent';
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: 'models/text-embedding-004',
        content: { parts: [{ text: clean.slice(0, 1000) }] }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const values = data?.embedding?.values;
    return Array.isArray(values) && values.length > 0 ? values : null;
  } catch {
    return null;
  }
}

const SENSITIVE_PATTERNS = [
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/, // CPF
  /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/, // CNPJ
  /\b(?:\d[ -]*?){13,19}\b/, // Cartão de crédito / sequência longa
  /\b(?:sk-[a-zA-Z0-9]{16,}|AIza[a-zA-Z0-9_-]{20,}|cfut_[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/i,
  /\b(?:senha|password|pin|cvv|token\s+secreto|chave\s+privada)\b/i
];

export function containsSensitiveData(text = '') {
  const s = String(text || '').trim();
  if (!s) return false;
  return SENSITIVE_PATTERNS.some((re) => re.test(s));
}

export function buildMemoryScopeKey({ tenantId = 'default', phone = '', isOwner = false } = {}) {
  const cleanTenant = String(tenantId || 'default').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'default';
  if (isOwner) return `${cleanTenant}:owner`;
  const digits = String(phone || '').replace(/@.*$/, '').replace(/\D/g, '');
  return digits ? `${cleanTenant}:${digits}` : `${cleanTenant}:anon`;
}

function tokenize(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function tokenSimilarity(a = '', b = '') {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const w of setA) {
    if (setB.has(w)) inter++;
  }
  return inter / Math.max(setA.size, setB.size);
}

export class MemoryStore {
  constructor(filePath = DEFAULT_MEMORY_FILE) {
    this.filePath = filePath;
    this.items = new Map();
    this._loaded = false;
  }

  _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        for (const item of Array.isArray(raw) ? raw : []) {
          if (item?.id && item?.scopeKey && item?.content) {
            this.items.set(item.id, item);
          }
        }
      }
    } catch {
      // fallback em memória se ainda não houver arquivo válido
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const all = [...this.items.values()].slice(-1000);
      if (this.items.size > 1000) {
        this.items = new Map(all.map((item) => [item.id, item]));
      }
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(all, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // falha de disco não interrompe o atendimento
    }
  }

  remember({
    scopeKey,
    type = 'fact',
    content = '',
    importance = 0.7,
    confidence = 0.85,
    source = 'conversation'
  } = {}) {
    this._ensureLoaded();
    const cleanScope = String(scopeKey || '').trim();
    const cleanContent = String(content || '').trim().replace(/\s+/g, ' ').slice(0, 240);
    const cleanType = VALID_TYPES.has(type) ? type : 'fact';
    const numImp = Math.max(0.1, Math.min(1, Number(importance) || 0.7));
    const numConf = Math.max(0.1, Math.min(1, Number(confidence) || 0.85));

    if (!cleanScope || cleanContent.length < 6) {
      return { saved: false, reason: 'invalid_input' };
    }
    if (numConf < 0.65) {
      return { saved: false, reason: 'low_confidence' };
    }
    if (containsSensitiveData(cleanContent)) {
      return { saved: false, reason: 'sensitive_data_blocked' };
    }

    const nowIso = new Date().toISOString();
    const existingList = [...this.items.values()].filter(
      (m) => m.scopeKey === cleanScope && m.status === 'active'
    );

    const match = existingList.find(
      (m) =>
        m.content.toLowerCase() === cleanContent.toLowerCase() ||
        (m.type === cleanType && tokenSimilarity(m.content, cleanContent) >= 0.65)
    );

    if (match) {
      match.content = cleanContent;
      match.importance = Math.max(match.importance || 0, numImp);
      match.confidence = Math.max(match.confidence || 0, numConf);
      match.source = source || match.source;
      match.updatedAt = nowIso;
      this.items.set(match.id, match);
      this._persist();
      return { saved: true, updated: true, memory: match };
    }

    const record = {
      id: crypto.randomUUID(),
      scopeKey: cleanScope,
      type: cleanType,
      content: cleanContent,
      importance: numImp,
      confidence: numConf,
      status: 'active',
      source: String(source || 'conversation'),
      createdAt: nowIso,
      updatedAt: nowIso
    };
    this.items.set(record.id, record);
    this._persist();
    return { saved: true, updated: false, memory: record };
  }

  list(scopeKey) {
    this._ensureLoaded();
    const cleanScope = String(scopeKey || '').trim();
    if (!cleanScope) return [];
    return [...this.items.values()]
      .filter((m) => m.scopeKey === cleanScope && m.status === 'active')
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  retrieve({ scopeKey, query = '', queryEmbedding = null, limit = 6 } = {}) {
    const active = this.list(scopeKey);
    if (active.length === 0) return [];
    const qTokens = new Set(tokenize(query));
    const nowMs = Date.now();

    const scored = active.map((m) => {
      let queryScore = 0;
      if (qTokens.size > 0) {
        const mTokens = new Set(tokenize(m.content));
        const hits = [...mTokens].filter(token => qTokens.has(token)).length;
        queryScore = hits > 0 ? Math.min(1, hits / Math.min(4, qTokens.size)) : 0;
      }
      const semanticScore = (Array.isArray(queryEmbedding) && Array.isArray(m.embedding))
        ? cosineSimilarity(queryEmbedding, m.embedding)
        : 0;
      const ageDays = Math.max(0, (nowMs - new Date(m.updatedAt || m.createdAt || nowMs).getTime()) / 86400000);
      const recencyScore = Math.max(0, 1 - ageDays / 90);
      const total = semanticScore * 1.8 + queryScore * 1.4 + (m.importance || 0.5) * 0.8 + recencyScore * 0.3;
      return { memory: m, total, queryScore, semanticScore };
    });

    // Preferências são referências estáveis e podem acompanhar qualquer assunto.
    // Fatos, decisões e projetos só entram quando há correspondência com a consulta atual.
    const preferences = scored
      .filter(item => item.memory.type === 'preference')
      .sort((a, b) => b.total - a.total)
      .slice(0, 2);
    const relevant = scored
      .filter(item => item.memory.type !== 'preference'
        && (item.queryScore >= 0.25 || item.semanticScore >= 0.62))
      .sort((a, b) => b.total - a.total);

    const maxItems = Math.max(1, Math.min(12, Number(limit) || 6));
    return [...preferences, ...relevant]
      .slice(0, maxItems)
      .map(item => item.memory);
  }

  async rememberWithEmbedding(params = {}, embedOpts = {}) {
    const res = this.remember(params);
    if (!res.saved || !res.memory) return res;
    // Do not keep a vector for old content if an update succeeds but embedding fails.
    delete res.memory.embedding;
    this.items.set(res.memory.id, res.memory);
    this._persist();
    const embedding = await generateMemoryEmbedding(res.memory.content, embedOpts);
    if (embedding) {
      res.memory.embedding = embedding;
      this.items.set(res.memory.id, res.memory);
      this._persist();
    }
    return res;
  }

  async correctWithEmbedding(params = {}, embedOpts = {}) {
    const res = this.correct(params);
    if (!res.updated || !res.memory) return res;
    delete res.memory.embedding;
    this.items.set(res.memory.id, res.memory);
    this._persist();
    const embedding = await generateMemoryEmbedding(res.memory.content, embedOpts);
    if (embedding) {
      res.memory.embedding = embedding;
      this.items.set(res.memory.id, res.memory);
      this._persist();
    }
    return res;
  }

  async retrieveSemantic({ scopeKey, query = '', limit = 6, ...embedOpts } = {}) {
    const active = this.list(scopeKey);
    // Avoid an embedding API request until this scope actually has semantic memories.
    if (!query || !active.some(item => Array.isArray(item.embedding) && item.embedding.length > 0)) {
      return this.retrieve({ scopeKey, query, limit });
    }
    const queryEmbedding = await generateMemoryEmbedding(query, embedOpts);
    return this.retrieve({ scopeKey, query, queryEmbedding, limit });
  }

  listAllScopes() {
    this._ensureLoaded();
    const map = new Map();
    for (const m of this.items.values()) {
      if (m.status !== 'active') continue;
      if (!map.has(m.scopeKey)) map.set(m.scopeKey, []);
      map.get(m.scopeKey).push(m);
    }
    return [...map.entries()].map(([scopeKey, items]) => ({
      scopeKey,
      count: items.length,
      items: items
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .map(({ embedding: _emb, ...rest }) => rest)
    }));
  }

  correctById({ id, scopeKey, newContent, type, importance } = {}) {
    return this.correct({ scopeKey, idOrQuery: id, newContent, type, importance });
  }

  forgetById({ id, scopeKey } = {}) {
    return this.forget({ scopeKey, idOrQuery: id });
  }

  correct({ scopeKey, idOrQuery = '', newContent = '', type, importance } = {}) {
    this._ensureLoaded();
    const cleanScope = String(scopeKey || '').trim();
    const cleanNew = String(newContent || '').trim().replace(/\s+/g, ' ').slice(0, 240);
    if (!cleanScope || !idOrQuery || cleanNew.length < 6) {
      return { updated: false, reason: 'invalid_input' };
    }
    if (containsSensitiveData(cleanNew)) {
      return { updated: false, reason: 'sensitive_data_blocked' };
    }

    const active = this.list(cleanScope);
    const target = active.find((m) => m.id === idOrQuery) ||
      active
        .map((m) => ({ m, sim: tokenSimilarity(m.content, idOrQuery) }))
        .sort((a, b) => b.sim - a.sim)
        .find((x) => x.sim >= 0.35)?.m;

    if (!target) return { updated: false, reason: 'not_found' };

    target.content = cleanNew;
    if (VALID_TYPES.has(type)) target.type = type;
    if (Number.isFinite(Number(importance))) {
      target.importance = Math.max(0.1, Math.min(1, Number(importance)));
    }
    target.updatedAt = new Date().toISOString();
    this.items.set(target.id, target);
    this._persist();
    return { updated: true, memory: target };
  }

  forget({ scopeKey, idOrQuery = '' } = {}) {
    this._ensureLoaded();
    const cleanScope = String(scopeKey || '').trim();
    const needle = String(idOrQuery || '').trim();
    if (!cleanScope || !needle) return { forgotten: false, count: 0 };

    const active = this.list(cleanScope);
    let count = 0;

    for (const m of active) {
      const exactId = m.id === needle;
      const textMatch = m.content.toLowerCase().includes(needle.toLowerCase()) || tokenSimilarity(m.content, needle) >= 0.45;
      if (exactId || textMatch) {
        // Exclusão física definitiva para conformidade LGPD (não conserva conteúdo esquecido)
        this.items.delete(m.id);
        count++;
      }
    }

    if (count > 0) this._persist();
    return { forgotten: count > 0, count };
  }
}

export const memoryStore = new MemoryStore();

/**
 * Extrator heurístico leve (zero chamadas extras de LLM) para capturar
 * preferências explícitas e nomes de projetos declarados pelo usuário.
 */
export function extractMemoryCandidates(userText = '') {
  const text = String(userText || '').trim();
  if (!text || text.length < 10 || containsSensitiveData(text)) return [];
  const candidates = [];

  if (/\b(?:prefiro|gosto\s+mais\s+de|quero\s+que\s+voc[êe]\s+(?:responda|seja|fale))\b/i.test(text)) {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 180);
    candidates.push({ type: 'preference', content: snippet, importance: 0.9, confidence: 0.9 });
  }

  const projMatch = text.match(/\b(?:estou\s+(?:desenvolvendo|criando|montando)|meu\s+projeto\s+(?:se\s+chama|[ée]))\s+([^.!?\n]{3,80})/i);
  if (projMatch) {
    candidates.push({
      type: 'project',
      content: `Projeto em andamento: ${projMatch[1].trim()}`,
      importance: 0.85,
      confidence: 0.88
    });
  }

  return candidates;
}

export function buildMemoryPromptSection(memories = []) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const lines = memories.slice(0, 6).map((m) => `- [${m.type}] ${m.content}`);
  return [
    '',
    '[MEMÓRIA PERSISTENTE DO CONTATO — REFERÊNCIA, NÃO ASSUNTO ATIVO]',
    'Use estas informações apenas quando forem relevantes ao pedido atual. A existência de uma memória não significa que o cliente quer retomar aquele projeto, tarefa ou conversa, nem que uma pendência antiga continua ativa.',
    'Não mude de assunto para mencionar projetos lembrados espontaneamente. Para retomar uma conversa anterior, procure o trecho solicitado no histórico; se não houver referência suficiente, pergunte qual assunto o cliente deseja recuperar.',
    ...lines
  ].join('\n');
}
