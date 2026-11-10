import { config } from '../config.mjs';

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

export function safeErrorDetail(body = '') {
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
    response_format: structuredOutputs ? { type: 'json_schema', json_schema: { name: 'lia_sync_response', strict: true, schema: openRouterSchema } } : { type: 'json_object' },
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
  const intents = new Set(['saudacao', 'atendimento', 'falar_com_responsavel', 'falar_com_tauan', 'planos', 'politicas', 'pagamento', 'preco', 'agendar', 'servico', 'duvida', 'duvida_geral', 'sintoma', 'emergencia', 'humano', 'lembrete', 'outro']);
  const c = o.collected && typeof o.collected === 'object' ? o.collected : {};
  const isHandoff = o.handoff === true || o.intent === 'falar_com_responsavel' || o.intent === 'falar_com_tauan' || o.intent === 'humano';
  const rem = o.reminder && typeof o.reminder === 'object' && o.reminder.text ? o.reminder : null;
  return {
    reply: typeof o.reply === 'string' ? o.reply : '',
    intent: intents.has(o.intent) ? o.intent : (isHandoff ? 'falar_com_responsavel' : 'outro'),
    red_flags: o.red_flags === true,
    handoff: isHandoff,
    handoff_reason: typeof o.handoff_reason === 'string' ? o.handoff_reason : null,
    reminder: rem,
    tool_calls: Array.isArray(o.tool_calls) ? o.tool_calls.filter(t => t && t.name) : [],
    collected: c
  };
}
