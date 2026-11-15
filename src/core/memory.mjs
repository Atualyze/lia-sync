import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_MEMORY_FILE = path.resolve(process.cwd(), 'data', 'memories.json');
const VALID_TYPES = new Set(['preference', 'project', 'decision', 'fact']);

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
      fs.writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf8');
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

  retrieve({ scopeKey, query = '', limit = 6 } = {}) {
    const active = this.list(scopeKey);
    if (active.length === 0) return [];
    const qTokens = new Set(tokenize(query));
    const nowMs = Date.now();

    const scored = active.map((m) => {
      let queryScore = 0;
      if (qTokens.size > 0) {
        const mTokens = tokenize(m.content);
        const hits = mTokens.filter((t) => qTokens.has(t)).length;
        queryScore = hits > 0 ? Math.min(1, hits / Math.min(4, qTokens.size)) : 0;
      }
      const ageDays = Math.max(0, (nowMs - new Date(m.updatedAt || m.createdAt || nowMs).getTime()) / 86400000);
      const recencyScore = Math.max(0, 1 - ageDays / 90);
      const total = queryScore * 1.4 + (m.importance || 0.5) * 0.8 + recencyScore * 0.3;
      return { memory: m, total };
    });

    scored.sort((a, b) => b.total - a.total);
    return scored.slice(0, Math.max(1, limit)).map((s) => s.memory);
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
    const nowIso = new Date().toISOString();
    let count = 0;

    for (const m of active) {
      const exactId = m.id === needle;
      const textMatch = m.content.toLowerCase().includes(needle.toLowerCase()) || tokenSimilarity(m.content, needle) >= 0.45;
      if (exactId || textMatch) {
        m.status = 'forgotten';
        m.updatedAt = nowIso;
        this.items.set(m.id, m);
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
  return `\n[MEMÓRIA PERSISTENTE DO CONTATO]\n${lines.join('\n')}`;
}
