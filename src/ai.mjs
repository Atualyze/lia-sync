import { config } from './config.mjs';
import { recordAICall, getMetricsSummary, resetMetrics } from './metrics.mjs';
import { decidirModeloPorContexto } from './model-router.mjs';

const failures = new Map();
const opened = new Map();
const PROVIDERS = ['gemini', 'openrouter', 'qwen', 'openai'];

export function resolveAIConfig(botConfig = {}) {
  const ai = botConfig?.ai || {};
  const provider = String(ai.activeProvider || '').toLowerCase();
  return {
    provider,
    model: typeof ai.activeModel === 'string' ? ai.activeModel.trim() : '',
    fallbackModels: Array.isArray(ai.fallbackModels) ? ai.fallbackModels.filter(Boolean) : [],
    maxOutputTokens: Math.max(2048, Number(ai.maxOutputTokens) || config.aiMaxOutputTokens || 2048),
    structuredOutputs: ai.structuredOutputs === true,
    requireParameters: ai.requireParameters === true
  };
}


export const responseSchema = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    intent: { type: 'STRING' },
    red_flags: { type: 'BOOLEAN' },
    handoff: { type: 'BOOLEAN' },
    handoff_reason: { type: 'STRING' },
    tool_calls: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          args: { type: 'OBJECT' }
        },
        required: ['name']
      }
    },
    reminder: {
      type: 'OBJECT',
      properties: {
        text: { type: 'STRING' },
        dueAt: { type: 'STRING' }
      }
    },
    collected: {
      type: 'OBJECT',
      properties: {
        clientName: { type: 'STRING' },
        subject: { type: 'STRING' }
      }
    }
  },
  required: ['reply', 'intent', 'red_flags', 'handoff']
};

export async function transcribeAudio(base64, mimetype = 'audio/ogg') {
  if (!config.geminiKey || !base64) return null;
  const cleanMime = String(mimetype).split(';')[0].trim() || 'audio/ogg';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${config.geminiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: cleanMime, data: base64 } },
            { text: "Transcreva este áudio em português com fidelidade total. Retorne apenas o texto transcrito, sem introduções ou explicações." }
          ]
        }]
      })
    });
    if (!res.ok) {
      console.error('[ai] transcribeAudio status:', res.status);
      return null;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? text.trim() : null;
  } catch (e) {
    console.error('[ai] transcribeAudio erro:', e.message);
    return null;
  }
}

/**
 * Analisa documentos e briefings em PDF com Gemini Flash multimodal
 */
export async function analyzeDocument({ base64, mimetype = 'application/pdf', caption = '' }) {
  if (!config.geminiKey || !base64) return null;
  const cleanMime = String(mimetype).split(';')[0].trim() || 'application/pdf';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${config.geminiKey}`;
  try {
    const promptText = `Você é a IA assistente executiva do Tauan.
Analise este documento com máxima fidelidade e síntese executiva.
Retorne um JSON estrito no seguinte formato:
{
  "summary": "Resumo executivo claro em 2 a 4 linhas em português do Brasil.",
  "docType": "proposta | contrato | briefing | comprovante | certidao | documento_geral",
  "keyPoints": ["Ponto 1 (valores, partes ou objeto)", "Ponto 2 (prazos ou condições)", "Ponto 3 (pendências ou observações)"],
  "actionNeeded": "Ação recomendada para o Tauan ou resposta sugerida ao cliente."
}
${caption ? `Contexto/Legenda enviada pelo cliente: "${caption}"` : ''}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: cleanMime, data: base64 } },
            { text: promptText }
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2
        }
      })
    });
    if (!res.ok) {
      console.error('[ai] analyzeDocument status:', res.status);
      return null;
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { summary: raw.trim(), docType: 'documento_geral', keyPoints: [], actionNeeded: 'Revisar anexo' };
    }
  } catch (e) {
    console.error('[ai] analyzeDocument erro:', e.message);
    return null;
  }
}

/**
 * Busca Web e Enriquecimento em tempo real via Google Search do Gemini
 */
export function shouldEnableGoogleSearch(text = '') {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return /(?:cota[cç][aã]o|d[oó]lar|euro|bitcoin|cripto|clima|tempo|previs[aã]o do tempo|previs[aã]o|not[ií]cia|not[ií]cias|manchete|pesquis|pesquise|busque|buscar na web|procurar no google|pesquisar no google|quem [eé]|quem foi|o que [eé]|o que diz|o que significa|di[aá]rio oficial|lei|provimento|cnj|tjsp|tjal|tjce|stf|stj|jurisprud[eê]ncia|notici[aá]rio|mercado financeiro|ibovespa)\b/i.test(lower);
}

export async function searchWebWithGemini(query) {
  if (!config.geminiKey || !query) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${config.geminiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.2
        }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map(p => p.text || '').join('').trim();
    const queries = candidate?.groundingMetadata?.webSearchQueries || [];
    return { text, queries };
  } catch (e) {
    console.error('[ai] searchWebWithGemini erro:', e.message);
    return null;
  }
}

const openRouterSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string', description: 'Resposta curta e acolhedora em português do Brasil.' },
    intent: { type: 'string', enum: ['saudacao', 'planos', 'politicas', 'pagamento', 'preco', 'agendar', 'servico', 'duvida_geral', 'sintoma', 'emergencia', 'humano', 'outro'] },
    red_flags: { type: 'boolean' },
    handoff: { type: 'boolean' },
    handoff_reason: { type: ['string', 'null'] },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          args: { type: 'object' }
        },
        required: ['name']
      }
    },
    collected: { type: 'object', additionalProperties: true }
  },
  required: ['reply', 'intent', 'red_flags', 'handoff', 'handoff_reason', 'collected']
};

function safeErrorDetail(body = '') {
  try {
    const data = JSON.parse(body);
    const error = data?.error || data;
    const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(': ');
    return detail.replace(/(?:sk|key|token)[-_]?[a-z0-9._-]{8,}/gi, '[redacted]').replace(/\b\d{8,15}\b/g, '[phone]');
  } catch { return ''; }
}

export function buildOpenRouterBody({ model, fallbackModels = [], system, history = [], userText, structuredOutputs = false, requireParameters = false }) {
  const body = {
    model,
    temperature: 0.2,
    max_tokens: config.aiMaxOutputTokens,
    messages: [{ role: 'system', content: system }, ...normalizeHistory(history), { role: 'user', content: userText }],
    response_format: structuredOutputs ? { type: 'json_schema', json_schema: { name: 'homevet_response', strict: true, schema: openRouterSchema } } : { type: 'json_object' },
    provider: { require_parameters: requireParameters, allow_fallbacks: true, sort: 'latency' }
  };
  const models = [...new Set(fallbackModels.filter(Boolean).filter(candidate => candidate !== model))].slice(0, 3);
  if (models.length) body.models = models;
  return body;
}

export function normalizeHistory(history = []) {
  const clean = history
    .filter(m => m && ['user', 'assistant', 'model'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role === 'model' ? 'assistant' : m.role, content: m.content.trim() }));
  while (clean.length && clean[0].role !== 'user') clean.shift();
  const out = [];
  for (const m of clean) {
    if (out.at(-1)?.role === m.role) out.at(-1).content += `\n${m.content}`;
    else out.push({ ...m });
  }
  return out;
}

function parseObject(raw) {
  const source = String(raw || '').replace(/```json|```/gi, '').trim();
  try { return JSON.parse(source); } catch {}
  const start = source.indexOf('{');
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, i + 1)); } catch { break; }
    }
  }
  return null;
}

export function extractTruncatedReply(raw) {
  const m = String(raw || '').match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return '';
}

export function parseAIResponse(raw) {
  const o = parseObject(raw);
  if (!o) {
    const source = String(raw || '').replace(/```json|```/gi, '').trim();
    if (/^\s*\{|"reply"\s*:/.test(source)) {
      const recovered = extractTruncatedReply(source);
      return { reply: recovered.trim(), intent: 'outro', red_flags: false, handoff: false, handoff_reason: null, collected: {} };
    }
    return { reply: String(raw || '').trim(), intent: 'outro', red_flags: false, handoff: false, handoff_reason: null, collected: {} };
  }
  const intents = new Set(['saudacao', 'atendimento', 'falar_com_tauan', 'planos', 'politicas', 'pagamento', 'preco', 'agendar', 'servico', 'duvida', 'duvida_geral', 'sintoma', 'emergencia', 'humano', 'lembrete', 'outro']);
  const c = o.collected && typeof o.collected === 'object' ? o.collected : {};
  const isHandoff = o.handoff === true || o.intent === 'falar_com_tauan' || o.intent === 'humano';
  const rem = o.reminder && typeof o.reminder === 'object' && o.reminder.text ? o.reminder : null;
  return {
    reply: typeof o.reply === 'string' ? o.reply : '',
    intent: intents.has(o.intent) ? o.intent : (isHandoff ? 'falar_com_tauan' : 'outro'),
    red_flags: o.red_flags === true,
    handoff: isHandoff,
    handoff_reason: typeof o.handoff_reason === 'string' ? o.handoff_reason : null,
    reminder: rem,
    tool_calls: Array.isArray(o.tool_calls) ? o.tool_calls.filter(t => t && t.name) : [],
    collected: c
  };
}

export const providers = (botConfig = {}) => {
  const p = resolveAIConfig(botConfig).provider;
  const others = PROVIDERS.filter(x => x !== p && Boolean(available(x)));
  const ordered = [p, ...others].filter(x => PROVIDERS.includes(x) && Boolean(available(x)));
  const now = Date.now();
  return ordered.sort((a, b) => {
    const aOpen = (opened.get(a) || 0) > now;
    const bOpen = (opened.get(b) || 0) > now;
    if (aOpen !== bOpen) return aOpen ? 1 : -1;
    return 0;
  });
};

export const available = provider =>
  provider === 'gemini' ? config.geminiKey :
  provider === 'openrouter' ? config.openrouterKey :
  provider === 'qwen' ? config.qwenKey :
  config.openaiKey;

export function getCircuitBreakers() {
  const all = ['gemini', 'openrouter', 'qwen', 'openai'];
  const res = {};
  const now = Date.now();
  for (const p of all) {
    const isAvail = Boolean(available(p));
    const failCount = failures.get(p) || 0;
    const openUntil = opened.get(p) || 0;
    const isQuarantine = openUntil > now;
    res[p] = {
      configured: isAvail,
      status: !isAvail ? 'nao_configurado' : (isQuarantine ? 'aberto' : (failCount > 0 ? 'degradado' : 'operacional')),
      failures: failCount,
      quarantineSeconds: isQuarantine ? Math.max(0, Math.ceil((openUntil - now) / 1000)) : 0
    };
  }
  return res;
}

export const OPENROUTER_FREE_MODELS = [
  {
    id: 'google/gemma-4-31b:free',
    name: 'Google: Gemma 4 31B (free)',
    provider: 'google',
    category: 'chat',
    recommended: true,
    contextWindow: '262K',
    params: '30.7B densos',
    role: 'Atendimento & Triagem (Recomendado)',
    description: 'Modelo denso multimodal avançado da Google DeepMind. Excelente fluência em português, raciocínio clínico para triagem e obediência a schemas JSON.'
  },
  {
    id: 'google/gemma-4-26b-a4b:free',
    name: 'Google: Gemma 4 26B A4B (free)',
    provider: 'google',
    category: 'chat',
    recommended: true,
    contextWindow: '262K',
    params: '25.2B total (3.8B ativos MoE)',
    role: 'Atendimento Rápido (Baixa Latência)',
    description: 'Mixture-of-Experts ultra ágil com apenas 3.8B parâmetros ativados por token. Latência mínima para respostas instantâneas no WhatsApp.'
  },
  {
    id: 'nvidia/nemotron-3-ultra:free',
    name: 'NVIDIA: Nemotron 3 Ultra (free)',
    provider: 'nvidia',
    category: 'chat',
    recommended: false,
    contextWindow: '1M',
    params: '550B total (55B ativos MoE)',
    role: 'Orquestração & Raciocínio Profundo',
    description: 'Modelo de fronteira híbrido Transformer-Mamba com 1 milhão de tokens de contexto. Forte em planejamento e workflows multi-etapa complexos.'
  },
  {
    id: 'nvidia/nemotron-3-super:free',
    name: 'NVIDIA: Nemotron 3 Super (free)',
    provider: 'nvidia',
    category: 'chat',
    recommended: false,
    contextWindow: '262K',
    params: '120B total (12B ativos MoE)',
    role: 'Adesão a Regras & Políticas',
    description: 'Arquitetura híbrida Mamba-Transformer MoE (12B ativos) com multi-token prediction. Alta precisão em regras de negócio e triagem segura.'
  },
  {
    id: 'poolside/laguna-xs-2.1:free',
    name: 'Poolside: Laguna XS 2.1 (free)',
    provider: 'poolside',
    category: 'chat',
    recommended: false,
    contextWindow: '256K',
    params: '33B FP8',
    role: 'Agente Compacto & Ferramentas',
    description: 'Modelo compacto quantizado em FP8 projetado para agentes e raciocínio com ferramentas.'
  },
  {
    id: 'cohere/north-mini-code:free',
    name: 'Cohere: North Mini Code (free)',
    provider: 'cohere',
    category: 'chat',
    recommended: false,
    contextWindow: '256K',
    params: '30B total (3B ativos MoE)',
    role: 'Agente & Tarefas de Código',
    description: 'MoE compacto da família North da Cohere. Especializado em ferramentas e tarefas de código.'
  },
  {
    id: 'nvidia/nemotron-3-nano-omni:free',
    name: 'NVIDIA: Nemotron 3 Nano Omni (free)',
    provider: 'nvidia',
    category: 'multimodal',
    recommended: false,
    contextWindow: '256K',
    params: '30B total (3B ativos MoE)',
    role: 'Multimodal (Visão & Áudio)',
    description: 'Sub-agente perceptivo multimodal para visão, vídeo e áudio.'
  },
  {
    id: 'nvidia/nemotron-3.5-content-safety:free',
    name: 'NVIDIA: Nemotron 3.5 Content Safety (free)',
    provider: 'nvidia',
    category: 'safety',
    recommended: false,
    contextWindow: '128K',
    params: '4B fine-tuned Gemma-3',
    role: 'Moderação & Guardrails (Não-Chat)',
    description: 'Modelo de segurança que classifica entradas e saídas como seguras/inseguras com justificativa (não gera respostas de atendimento).'
  },
  {
    id: 'nvidia/nemotron-3-embed-1b:free',
    name: 'NVIDIA: Nemotron 3 Embed 1B (free)',
    provider: 'nvidia',
    category: 'embedding',
    recommended: false,
    contextWindow: '33K',
    params: '1B denso',
    role: 'Embedding Vetorial / RAG (Não-Chat)',
    description: 'Modelo de embeddings de texto de alta densidade para busca semântica em base de conhecimento FAQ/RAG (retorna vetores numéricos, não texto).'
  },
  {
    id: 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
    name: 'NVIDIA: Llama Nemotron Embed VL 1B V2 (free)',
    provider: 'nvidia',
    category: 'embedding',
    recommended: false,
    contextWindow: '131K',
    params: '1.7B multimodal',
    role: 'Embedding Multimodal / RAG (Não-Chat)',
    description: 'Gera vetores para busca multimodal em tabelas, infográficos e texto.'
  },
  {
    id: 'nvidia/llama-nemotron-rerank-vl-1b-v2:free',
    name: 'NVIDIA: Llama Nemotron Rerank VL 1B V2 (free)',
    provider: 'nvidia',
    category: 'rerank',
    recommended: false,
    contextWindow: '10K',
    params: '1.7B cross-encoder',
    role: 'Reranker / RAG (Não-Chat)',
    description: 'Reordena documentos mais relevantes em pipelines de busca semântica.'
  }
];

export async function call(provider, {
  system,
  history = [],
  userText,
  deadline,
  fixedModel,
  preferredModel,
  model: legacyModel,
  aiConfig = {},
  enableSearch
}) {
  if (!available(provider) || opened.get(provider) > Date.now()) return null;
  const runtime = resolveAIConfig({ ai: aiConfig });
  const timeoutMs = Math.max(1, Math.min(config.aiTimeoutMs, (deadline ? deadline - Date.now() : config.aiTimeoutMs)));

  if (provider === 'gemini') {
    // Modelo fixo: tenta só ele, sem cadeia
    // Modelo preferido: tenta o roteado e depois a cadeia padrão
    const candidateModels = fixedModel
      ? [fixedModel]
      : [
          preferredModel || legacyModel,
          (runtime.model && runtime.model !== 'gemini-1.5-flash') ? runtime.model : null,
          ...runtime.fallbackModels,
          'gemini-3.8-flash',
          'gemini-flash-latest'
        ].filter((m, i, arr) => m && arr.indexOf(m) === i);

    let primaryErr = null;
    let lastErr = null;
    const needsSearch = Boolean(enableSearch || shouldEnableGoogleSearch(userText));

    for (const model of candidateModels) {
      try {
        const remainingMs = deadline ? deadline - Date.now() : config.aiTimeoutMs;
        if (remainingMs <= 100) break;
        const perModelTimeout = Math.max(1000, Math.min(config.aiTimeoutMs, remainingMs));
        const modelSignal = AbortSignal.timeout(perModelTimeout);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const genConfig = {
          temperature: 0.2,
          maxOutputTokens: runtime.maxOutputTokens,
          responseMimeType: 'application/json',
          responseSchema
        };
        if (model.includes('2.5') && config.geminiThinkingBudget !== undefined) {
          genConfig.thinkingConfig = { thinkingBudget: config.geminiThinkingBudget };
        }
        const body = {
          systemInstruction: { parts: [{ text: system }] },
          contents: [...normalizeHistory(history), { role: 'user', content: userText }].map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          })),
          generationConfig: genConfig,
          ...(needsSearch ? { tools: [{ google_search: {} }] } : {})
        };
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
          signal: modelSignal,
          body: JSON.stringify(body)
        });
        if (!response.ok) throw Error(`Gemini ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates?.[0];
        if (candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) throw Error(`Gemini ${candidate.finishReason}`);
        const raw = candidate?.content?.parts?.map(part => part.text || '').join('') || null;
        const usage = data.usageMetadata;
        const promptTokens = usage?.promptTokenCount || Math.ceil(((system?.length || 0) + (userText?.length || 0)) / 4);
        const completionTokens = usage?.candidatesTokenCount || Math.ceil((raw?.length || 0) / 4);
        const totalTokens = usage?.totalTokenCount || (promptTokens + completionTokens);
        return { raw, tokens: { promptTokens, completionTokens, totalTokens }, model };
      } catch (err) {
        if (!primaryErr) primaryErr = err;
        lastErr = err;
        // Só cai para o próximo modelo em erros transitórios, e nunca no modo fixo
        if (fixedModel || !/\b(404|429|5\d\d)\b/.test(err.message)) break;
      }
    }
    throw primaryErr || lastErr || Error('Gemini failed');
  }

  // Provedores não-Gemini usam o modelo que lhes foi atribuído
  const model = fixedModel || preferredModel || legacyModel || (provider === 'openrouter' ? 'nvidia/nemotron-3.5-lightning:free' : '');
  const signal = AbortSignal.timeout(timeoutMs);
  const base = provider === 'openrouter' ? config.openrouterBaseUrl : provider === 'qwen' ? config.qwenBaseUrl : 'https://api.openai.com/v1';
  const key = provider === 'openrouter' ? config.openrouterKey : provider === 'qwen' ? config.qwenKey : config.openaiKey;
  const headers = { 'content-type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider === 'openrouter') {
    if (config.openrouterSiteUrl) headers['HTTP-Referer'] = config.openrouterSiteUrl;
    if (config.openrouterAppName) headers['X-Title'] = config.openrouterAppName;
  }
  const body = provider === 'openrouter'
    ? buildOpenRouterBody({ model, fallbackModels: runtime.fallbackModels, system, history, userText, structuredOutputs: runtime.structuredOutputs, requireParameters: runtime.requireParameters })
    : { model, temperature: 0.2, max_tokens: config.aiMaxOutputTokens, messages: [{ role: 'system', content: system }, ...normalizeHistory(history), { role: 'user', content: userText }], response_format: { type: 'json_object' } };
  const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify(body) });
  if (!response.ok) { const detail = safeErrorDetail(await response.text()); throw Error(`${provider} ${response.status}${detail ? ` — ${detail}` : ''}`); }
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || null;
  const usage = data.usage;
  const promptTokens = usage?.prompt_tokens || Math.ceil(((system?.length || 0) + (userText?.length || 0)) / 4);
  const completionTokens = usage?.completion_tokens || Math.ceil((raw?.length || 0) / 4);
  const totalTokens = usage?.total_tokens || (promptTokens + completionTokens);
  return { raw, tokens: { promptTokens, completionTokens, totalTokens }, model: data.model || model };
}

/**
 * Retorna o modelo apropriado para cada provedor.
 * Modelos do Gemini (gemini-*) só são usados no provedor gemini.
 */
function providerDefaultModel(provider, aiConfig, fixedModel) {
  if (fixedModel && provider === aiConfig.provider) return fixedModel;
  if (provider === aiConfig.provider) return aiConfig.model;
  if (provider === 'openrouter') return 'nvidia/nemotron-3.5-lightning:free';
  return '';
}

export async function askAI(args) {
  const aiConfig = resolveAIConfig(args?.botConfig);
  if (!PROVIDERS.includes(aiConfig.provider) || !aiConfig.model) {
    console.warn('[ai] Nenhum provedor/modelo foi publicado no dashboard.');
    return null;
  }

  // Roteamento Dinâmico de Complexidade (MoA / Mixture of Agents)
  const isAutoRouting = args?.botConfig?.ai?.autoRouting !== false;
  const decision = decidirModeloPorContexto({
    userText: args?.userText,
    history: args?.history,
    isTauan: args?.isTauan === true,
    isSuperAgent: args?.botConfig?.ai?.agentMode === 'super_agente' || args?.botConfig?.ai?.enableToolCalling === true,
    configuredModel: aiConfig.model,
    autoRoutingEnabled: isAutoRouting
  });

  // Modo fixo (OpenRouter, qwen, gpt ou auto-roteamento desligado): sem cadeia de fallback
  const fixedModel = decision.tier === 'custom' ? decision.model : null;
  const preferredModel = decision.tier === 'custom' ? null : decision.model;

  const deadline = Date.now() + 35000;
  for (const provider of providers(args?.botConfig)) {
    const start = Date.now();
    // Cada provedor recebe o modelo que lhe pertence. Nunca o do Gemini.
    const providerModel = providerDefaultModel(provider, aiConfig, fixedModel);
    if (!providerModel && provider !== 'gemini') continue; // sem modelo, não tenta

    try {
      const res = await call(provider, {
        ...args,
        deadline,
        aiConfig,
        fixedModel: provider === 'gemini' ? fixedModel : providerModel,
        preferredModel: provider === 'gemini' ? preferredModel : null
      });
      if (res?.raw) {
        failures.set(provider, 0);
        opened.delete(provider);
        const parsed = parseAIResponse(res.raw);
        recordAICall({
          provider,
          model: res.model || providerModel || preferredModel || 'gemini-3.8-flash',
          latencyMs: Date.now() - start,
          promptTokens: res.tokens?.promptTokens,
          completionTokens: res.tokens?.completionTokens,
          totalTokens: res.tokens?.totalTokens,
          intent: parsed.intent,
          success: true,
          error: null
        });
        return parsed;
      }
    } catch (error) {
      const count = (failures.get(provider) || 0) + 1;
      failures.set(provider, count);
      if (count >= 3 || /\b(429|401|403)\b/.test(error.message)) opened.set(provider, Date.now() + 60000);
      recordAICall({
        provider,
        model: providerModel || preferredModel || 'unknown',
        latencyMs: Date.now() - start,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        intent: 'falha',
        success: false,
        error: error.message
      });
      console.error(`[ai:${provider}]`, error.message);
    }
  }
  return null;
}

export async function pingAI(targetProvider, targetModel) {
  const p = targetProvider || '';
  const start = Date.now();
  const model = targetModel || '';
  if (!available(p)) return { ok: false, provider: p, model, latencyMs: 0, error: `${p} não configurado. Informe a chave de API no .env e reinicie o serviço.` };
  const system = 'Você é o assistente técnico do Clubinho HomeVet. Responda em JSON {"status":"ok","mensagem":"conectado"}.';
  const userText = 'teste de conexão';
  try {
    const res = await call(p, { system, history: [], userText, deadline: Date.now() + 15000, model });
    const latencyMs = Date.now() - start;
    if (!res?.raw) throw new Error('Resposta vazia');
    const executedModel = res.model || model;
    recordAICall({
      provider: p,
      model: executedModel,
      latencyMs,
      promptTokens: res.tokens?.promptTokens,
      completionTokens: res.tokens?.completionTokens,
      totalTokens: res.tokens?.totalTokens,
      intent: 'ping_teste',
      success: true,
      error: null
    });
    return {
      ok: true,
      provider: p,
      model: executedModel,
      latencyMs,
      tokens: res.tokens,
      status: 'conectado'
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    recordAICall({
      provider: p,
      model,
      latencyMs,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      intent: 'ping_falha',
      success: false,
      error: err.message
    });
    return {
      ok: false,
      provider: p,
      model,
      latencyMs,
      error: err.message
    };
  }
}

export function getAIMetrics() {
  return getMetricsSummary(getCircuitBreakers());
}

export { resetMetrics };

export async function synthesizeVoice(text, { voiceName = 'Aoede', botConfig = {} } = {}) {
  if (!config.geminiKey || !text) return null;
  const selectedVoice = botConfig?.voice?.voiceName || voiceName || 'Aoede';
  const cleanText = String(text)
    .replace(/[*_#`~]/g, '')
    .replace(/https?:\/\/\S+/g, 'link enviado')
    .replace(/[•\-\+]\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanText) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent?key=${config.geminiKey}`;
  const payload = {
    contents: [
      { parts: [{ text: cleanText }] }
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: selectedVoice
          }
        }
      }
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[ai] synthesizeVoice HTTP erro:', res.status, err);
      return null;
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (p.inlineData?.data) {
        return { base64: p.inlineData.data, mimeType: p.inlineData.mimeType || 'audio/wav', voiceName: selectedVoice };
      }
    }
    return null;
  } catch (err) {
    console.error('[ai] synthesizeVoice erro:', err.message);
    return null;
  }
}
