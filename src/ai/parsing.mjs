import { config } from '../config.mjs';

export const responseSchema = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    intent: { type: 'STRING', enum: ['saudacao', 'atendimento', 'falar_com_responsavel', 'planos', 'politicas', 'pagamento', 'preco', 'agendar', 'servico', 'duvida', 'duvida_geral', 'sintoma', 'emergencia', 'humano', 'lembrete', 'status', 'comando', 'chat', 'envio_mensagem', 'outro'] },
    red_flags: { type: 'BOOLEAN' },
    handoff: { type: 'BOOLEAN' },
    handoff_category: { type: 'STRING', nullable: true, enum: ['financeiro', 'reclamacao', 'pedido_pessoa', 'emergencia'] },
    handoff_reason: { type: 'STRING', nullable: true },
    commitment_required: { type: 'BOOLEAN' },
    commitment: {
      type: 'OBJECT',
      nullable: true,
      properties: {
        title: { type: 'STRING' },
        description: { type: 'STRING' },
        due_at: { type: 'STRING' },
        recipient_type: { type: 'STRING', enum: ['client', 'owner'] },
        owner_type: { type: 'STRING', enum: ['bot', 'owner'] },
        category: { type: 'STRING', enum: ['financeiro', 'reclamacao', 'pedido_pessoa', 'emergencia', 'outro'] }
      },
      required: ['title', 'description', 'due_at', 'recipient_type', 'owner_type', 'category']
    },
    needs_tool: { type: 'BOOLEAN' },
    sector: { type: 'STRING', nullable: true, enum: ['vendas', 'comercial', 'suporte', 'financeiro', 'reclamacao', 'responsavel'] },
    sentiment: { type: 'STRING', nullable: true },
    context_summary: { type: 'STRING', nullable: true },
    tool_calls: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          args: {
            type: 'OBJECT',
            properties: {
              recipient: { type: 'STRING', nullable: true },
              message: { type: 'STRING', nullable: true },
              asAudio: { type: 'BOOLEAN', nullable: true },
              query: { type: 'STRING', nullable: true },
              action: { type: 'STRING', nullable: true },
              date: { type: 'STRING', nullable: true },
              startTime: { type: 'STRING', nullable: true },
              time: { type: 'STRING', nullable: true },
              summary: { type: 'STRING', nullable: true },
              target: { type: 'STRING', nullable: true },
              tipo: { type: 'STRING', nullable: true },
              titulo: { type: 'STRING', nullable: true },
              destinatario: { type: 'STRING', nullable: true },
              conteudo: { type: 'STRING', nullable: true },
              valor: { type: 'STRING', nullable: true },
              setor: { type: 'STRING', nullable: true },
              motivo: { type: 'STRING', nullable: true },
              phone: { type: 'STRING', nullable: true },
              reason: { type: 'STRING', nullable: true },
              when: { type: 'STRING', nullable: true },
              name: { type: 'STRING', nullable: true },
              termo: { type: 'STRING', nullable: true },
              interesse: { type: 'STRING', nullable: true },
              observacoes: { type: 'STRING', nullable: true },
              estagio: { type: 'STRING', nullable: true }
            }
          }
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
    conversation_state: {
      type: 'OBJECT',
      properties: {
        objective: { type: 'STRING' },
        need: { type: 'STRING' },
        next_step: { type: 'STRING' },
        confirmed: { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: ['objective', 'need', 'next_step', 'confirmed']
    },
    collected: {
      type: 'OBJECT',
      properties: {
        clientName: { type: 'STRING' },
        subject: { type: 'STRING' }
      }
    }
  },
  required: ['reply', 'intent', 'red_flags', 'handoff', 'handoff_category', 'commitment_required', 'commitment', 'needs_tool', 'conversation_state']
};

const openRouterSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string', description: 'Resposta curta e acolhedora em português do Brasil.' },
    intent: { type: 'string', enum: ['saudacao', 'atendimento', 'falar_com_responsavel', 'planos', 'politicas', 'pagamento', 'preco', 'agendar', 'servico', 'duvida', 'duvida_geral', 'sintoma', 'emergencia', 'humano', 'lembrete', 'status', 'comando', 'chat', 'envio_mensagem', 'outro'] },
    red_flags: { type: 'boolean' },
    handoff: { type: 'boolean' },
    handoff_category: { type: ['string', 'null'], enum: ['financeiro', 'reclamacao', 'pedido_pessoa', 'emergencia', null] },
    handoff_reason: { type: ['string', 'null'] },
    commitment_required: { type: 'boolean' },
    commitment: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        due_at: { type: 'string' },
        recipient_type: { type: 'string', enum: ['client', 'owner'] },
        owner_type: { type: 'string', enum: ['bot', 'owner'] },
        category: { type: 'string', enum: ['financeiro', 'reclamacao', 'pedido_pessoa', 'emergencia', 'outro'] }
      },
      required: ['title', 'description', 'due_at', 'recipient_type', 'owner_type', 'category']
    },
    needs_tool: { type: 'boolean' },
    sector: { type: ['string', 'null'], enum: ['vendas', 'comercial', 'suporte', 'financeiro', 'reclamacao', 'responsavel', null] },
    sentiment: { type: ['string', 'null'] },
    context_summary: { type: ['string', 'null'] },
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
    conversation_state: {
      type: 'object',
      additionalProperties: false,
      properties: {
        objective: { type: 'string' },
        need: { type: 'string' },
        next_step: { type: 'string' },
        confirmed: { type: 'array', items: { type: 'string' } }
      },
      required: ['objective', 'need', 'next_step', 'confirmed']
    },
    collected: { type: 'object', additionalProperties: true }
  },
  required: ['reply', 'intent', 'red_flags', 'handoff', 'handoff_category', 'handoff_reason', 'commitment_required', 'commitment', 'needs_tool', 'conversation_state', 'collected']
};

export function safeErrorDetail(body = '') {
  try {
    const data = JSON.parse(body);
    const error = data?.error || data;
    const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(': ');
    return detail.replace(/(?:sk|key|token)[-_]?[a-z0-9._-]{8,}/gi, '[redacted]').replace(/\b\d{8,15}\b/g, '[phone]');
  } catch { return ''; }
}

export function buildOpenRouterBody({ model, fallbackModels = [], system, history = [], userText, structuredOutputs = false, requireParameters = false, tools = [] }) {
  const isFreeOrReasoning = model === 'openrouter/free' || /:free$/i.test(String(model || '')) || /(?:nemotron|deepseek|r1|qwen3|gpt-oss|gemma-4|thinking)/i.test(String(model || ''));
  const body = {
    model,
    temperature: 0.2,
    max_tokens: isFreeOrReasoning ? Math.max(2048, config.aiMaxOutputTokens) : config.aiMaxOutputTokens,
    messages: [{ role: 'system', content: system }, ...normalizeHistory(history), { role: 'user', content: userText }],
    response_format: structuredOutputs ? { type: 'json_schema', json_schema: { name: 'lia_sync_response', strict: true, schema: openRouterSchema } } : { type: 'json_object' },
    ...(isFreeOrReasoning ? { reasoning: { effort: 'low' } } : {}),
    provider: { require_parameters: requireParameters, allow_fallbacks: true, sort: 'latency' },
    ...(Array.isArray(tools) && tools.length ? {
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      tool_choice: 'auto'
    } : {})
  };
  const models = [...new Set(fallbackModels.filter(Boolean).filter(candidate => candidate !== model))].slice(0, 3);
  if (models.length) body.models = models;
  return body;
}

export function normalizeHistory(history = []) {
  const clean = history
    .filter(m => m && ['user', 'assistant', 'model'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role === 'model' ? 'assistant' : m.role, content: m.content.trim().slice(-3000) }));
  if (clean.length && clean[0].role !== 'user') {
    const hasLaterAssistant = clean.slice(1).some(m => m.role === 'assistant');
    if (hasLaterAssistant) {
      while (clean.length && clean[0].role !== 'user') clean.shift();
    } else {
      clean.unshift({ role: 'user', content: '[Retomada da conversa em andamento]' });
    }
  }
  const out = [];
  for (const m of clean) {
    if (out.at(-1)?.role === m.role) out.at(-1).content = `${out.at(-1).content}\n${m.content}`.slice(-3000);
    else out.push({ ...m });
  }
  const bounded = [];
  let chars = 0;
  for (let i = out.length - 1; i >= 0 && bounded.length < 24; i--) {
    const item = out[i];
    if (chars + item.content.length > 12000) break;
    bounded.unshift(item);
    chars += item.content.length;
  }
  if (bounded.length && bounded[0].role !== 'user') {
    const firstIdx = out.indexOf(bounded[0]);
    const remainingBudget = 12000 - chars;
    if (bounded.length < 24 && firstIdx > 0 && out[firstIdx - 1]?.role === 'user' && remainingBudget >= 32) {
      bounded.unshift({
        role: 'user',
        content: out[firstIdx - 1].content.slice(-Math.min(1500, remainingBudget))
      });
    } else if (bounded.length < 24 && remainingBudget >= 34) {
      bounded.unshift({ role: 'user', content: '[Retomada da conversa em andamento]' });
    } else {
      while (bounded.length && bounded[0].role !== 'user') bounded.shift();
    }
  }
  return bounded;
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
      return { reply: recovered.trim(), intent: 'outro', red_flags: false, handoff: false, handoff_category: null, handoff_reason: null, commitment_required: false, commitment: null, needs_tool: false, collected: {} };
    }
    return { reply: String(raw || '').trim(), intent: 'outro', red_flags: false, handoff: false, handoff_category: null, handoff_reason: null, commitment_required: false, commitment: null, needs_tool: false, collected: {} };
  }
  const intents = new Set(['saudacao', 'atendimento', 'falar_com_responsavel', 'planos', 'politicas', 'pagamento', 'preco', 'agendar', 'servico', 'duvida', 'duvida_geral', 'sintoma', 'emergencia', 'humano', 'lembrete', 'status', 'comando', 'chat', 'envio_mensagem', 'outro']);
  const c = o.collected && typeof o.collected === 'object' ? o.collected : {};
  const rem = o.reminder && typeof o.reminder === 'object' && o.reminder.text ? o.reminder : null;
  const validHandoffCategories = new Set(['financeiro', 'reclamacao', 'pedido_pessoa', 'emergencia']);
  const rawHandoffCategory = typeof o.handoff_category === 'string' ? o.handoff_category.trim().toLowerCase() : '';
  // Fail closed: handoff requires both the boolean decision and an allowed category.
  const handoffCategory = o.handoff === true && validHandoffCategories.has(rawHandoffCategory) ? rawHandoffCategory : null;
  const validSectors = new Set(['vendas', 'comercial', 'suporte', 'financeiro', 'reclamacao', 'responsavel']);
  const rawSector = typeof o.sector === 'string' ? o.sector.trim().toLowerCase() : '';
  const validSentiments = new Set(['positivo', 'neutro', 'confuso', 'frustrado', 'urgente']);
  const rawSentiment = typeof o.sentiment === 'string' ? o.sentiment.trim().toLowerCase() : '';
  const commitmentRequired = o.commitment_required === true;
  const candidateCommitment = o.commitment && typeof o.commitment === 'object' && !Array.isArray(o.commitment) ? o.commitment : null;
  const dueAt = Date.parse(candidateCommitment?.due_at || '');
  const validCommitmentCategories = new Set(['financeiro', 'reclamacao', 'pedido_pessoa', 'emergencia', 'outro']);
  const validCommitment = commitmentRequired && candidateCommitment
    && typeof candidateCommitment.title === 'string' && candidateCommitment.title.trim()
    && typeof candidateCommitment.description === 'string'
    && Number.isFinite(dueAt)
    && ['client', 'owner'].includes(candidateCommitment.recipient_type)
    && ['bot', 'owner'].includes(candidateCommitment.owner_type)
    && validCommitmentCategories.has(candidateCommitment.category);
  const commitment = validCommitment ? {
    title: candidateCommitment.title.trim().slice(0, 200),
    description: candidateCommitment.description.trim().slice(0, 1000),
    due_at: new Date(dueAt).toISOString(),
    recipient_type: candidateCommitment.recipient_type,
    owner_type: candidateCommitment.owner_type,
    category: candidateCommitment.category
  } : null;
  const candidateToolCalls = o.needs_tool === false ? [] : (Array.isArray(o.tool_calls) ? o.tool_calls : []);
  const cleanToolCalls = candidateToolCalls
    .filter(t => t && typeof t.name === 'string' && t.name.trim())
    .map(t => ({
      name: t.name.trim(),
      args: t.args && typeof t.args === 'object'
        ? Object.fromEntries(Object.entries(t.args).filter(([, v]) => v !== null && v !== undefined))
        : {}
    }));
  const rawState = o.conversation_state && typeof o.conversation_state === 'object' ? o.conversation_state : null;
  const conversationState = rawState ? {
    objective: String(rawState.objective || '').trim().slice(0, 240),
    need: String(rawState.need || '').trim().slice(0, 240),
    next_step: String(rawState.next_step || '').trim().slice(0, 240),
    confirmed: Array.isArray(rawState.confirmed)
      ? rawState.confirmed.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : []
  } : null;
  return {
    reply: typeof o.reply === 'string' ? o.reply : '',
    intent: intents.has(o.intent) ? o.intent : (handoffCategory ? 'falar_com_responsavel' : 'outro'),
    red_flags: o.red_flags === true,
    handoff: Boolean(handoffCategory),
    handoff_category: handoffCategory,
    handoff_reason: handoffCategory && typeof o.handoff_reason === 'string' ? o.handoff_reason.trim().slice(0, 300) : null,
    commitment_required: commitmentRequired,
    commitment,
    needs_tool: cleanToolCalls.length > 0,
    sector: validSectors.has(rawSector) ? (rawSector === 'comercial' ? 'vendas' : rawSector) : null,
    sentiment: validSentiments.has(rawSentiment) ? rawSentiment : null,
    context_summary: typeof o.context_summary === 'string' && o.context_summary.trim() ? o.context_summary.trim().slice(0, 280) : null,
    conversation_state: conversationState,
    reminder: rem,
    tool_calls: cleanToolCalls,
    collected: c
  };
}
