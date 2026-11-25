import { normalize, detectPriceMentions } from '../safety.mjs';

export const NATURAL_CONTROL_HINT = /(?:\b(?:retom\w*|continu\w*|devolv\w*|reativ\w*|assum\w*|paus\w*\s+(?:o\s+)?(?:bot|atendimento|conversa)|human\w*\s+(?:o\s+)?atendimento)\b|\b(?:quem|quais?)\s+(?:est[aã]o?|aguard\w*).*(?:fila|retorno|resposta)\b|\b(?:mostr\w*|ver)\b.*\b(?:fila|aguard\w*)\b|\b(?:situa[cç][aã]o|sa[uú]de)\b.*\bsistema\b|\b(?:limp\w*|reset\w*)\b.*\b(?:hist[oó]rico|conversa)\b)/i;

export const COPILOT_PENDING_TTL_MS = 30 * 60 * 1000;
export const COPILOT_TASK_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
export const COPILOT_PIX_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;
export const COPILOT_CONTEXT_LIMIT = 8;

const COPILOT_TASK_PATTERNS = [
  ['payment', /\b(?:pix|cobranc\w*|cobr(?:ar|e|o)\w*|pagament\w*|infinitepay|qr\s*code|copia\s+e\s+cola)\b/i],
  ['dispatch', /\b(?:mensagem|recado|dispar\w*|envi\w*|mand\w*|avise?\w*|audio|áudio|voz)\b/i],
  ['followup', /\b(?:lembre\w*|lembrete\w*|retorno\w*|follow[- ]?up)\b/i],
  ['agenda', /\b(?:agenda|agend\w*|reuni\w*|compromisso\w*|hor[aá]rios?\s+livres|marc\w*)\b/i],
  ['document', /\b(?:pdf|or[cç]amento|proposta|recibo|declara[cç][aã]o|relat[oó]rio)\b/i],
  ['drive', /\b(?:drive|cat[aá]logo|contrato|arquivo|documento)\b/i],
  ['sheet', /\b(?:planilha|sheets|estoque|tabela)\b/i],
  ['public_data', /\b(?:cep|cnpj|feriado)\b/i],
  ['crm', /\b(?:crm|atualiz\w*|corrig\w*|cadastro)\b/i],
  ['contact', /\b(?:contato|lead|telefone|hist[oó]rico\s+do\s+cliente)\b/i],
  ['memory', /\b(?:mem[oó]ria|memorize|lembre-se|esque[cç]a|guarde)\b/i],
  ['infra', /(?:\b(?:infra|servidor\w*|vps|dokku|containers?)\b|\b(?:rodei|fiz|apliquei|terminei|conclu[ií]|atualizei|atualizamos|publiquei|subi|reiniciei|reiniciamos|deploy)\b.{0,120}\b(?:est[aá]\s+tudo\s+(?:ok|certo|normal)|est[aá]\s+(?:funcionando|normal)|como\s+(?:est[aá]|ficou)|tem\s+(?:algum|alguma)\s+(?:falha|erro|problema)|deu\s+(?:algum\s+)?(?:problema|erro)|est[aá]\s+saud[aá]vel)\b)/i],
  ['web', /\b(?:pesquis\w*|procur\w*|busc\w*\s+(?:na\s+)?web|consulta\w*\s+web)\b/i],
  ['knowledge', /\b(?:base\s+de\s+conhecimento|dossi[eê]|manual\s+operacional)\b/i],
  ['self_maintenance', /\b(?:c[oó]digo|bug|erro|falha|configura[cç][aã]o|configura[cç][oõ]es|par[aâ]metro|comportamento)\b.{0,120}\b(?:corrig\w*|consert\w*|ajust\w*|alter\w*|edit\w*|mud\w*|configur\w*|repar\w*)\b/i]
];

const TOOL_TASK_TYPES = Object.freeze({
  gerenciar_cobranca_pagamento: 'payment',
  enviar_mensagem_contato: 'dispatch', gerenciar_agenda_google: 'agenda',
  agendar_retorno_ou_followup: 'followup', gerar_documento_pdf: 'document',
  gerenciar_drive_google: 'drive', consultar_planilha_google: 'sheet',
  consultar_dados_brasil: 'public_data', consultar_contato_ou_lead: 'contact',
  atualizar_dados_crm: 'crm', gerenciar_memoria: 'memory', salvar_contato: 'contact',
  consultar_saude_infra: 'infra', consultar_web: 'web',
  consultar_base_conhecimento: 'knowledge',
  gerenciar_codigo: 'self_maintenance', gerenciar_configuracao: 'self_maintenance',
  transferir_setor: 'handoff', transferir_para_setor: 'handoff'
});

const QUESTION_STOP_WORDS = new Set(['qual', 'quais', 'como', 'pode', 'poderia', 'me', 'diga', 'informe', 'informar', 'para', 'por', 'uma', 'um', 'do', 'da', 'de', 'o', 'a', 'e', 'eu', 'voce', 'você', 'quer', 'preciso', 'ainda', 'agora', 'gerar', 'criar', 'audio', 'áudio', 'voz', 'mensagem', 'recado', 'envio', 'enviar', 'mande', 'mandar', 'gravar', 'grave']);

export function normalizePixAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let normalized = value.trim().replace(/\s+/g, '').replace(/^R\$/i, '');
  if (!normalized) return null;
  const comma = normalized.lastIndexOf(',');
  const dot = normalized.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    normalized = comma > dot
      ? normalized.replace(/\./g, '').replace(',', '.')
      : normalized.replace(/,/g, '');
  } else if (comma >= 0) {
    normalized = normalized.replace(',', '.');
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

export function inferCopilotTaskTypes(text = '') {
  const value = String(text || '');
  return COPILOT_TASK_PATTERNS
    .filter(([, pattern]) => pattern.test(value))
    .map(([type]) => type);
}

export function copilotToolTaskType(toolName = '', args = {}) {
  const type = TOOL_TASK_TYPES[String(toolName || '').trim()];
  if (toolName === 'gerenciar_cobranca_pagamento' && String(args?.acao || 'criar_checkout') === 'verificar_pagamento') return 'payment';
  return type || null;
}

export function activeCopilotTask(session, nowMs = Date.now()) {
  const task = session?.pendingCopilotTask;
  if (!task || typeof task !== 'object') return null;
  const createdAt = Date.parse(task.createdAt || '');
  const contextTtl = task.taskId
    ? COPILOT_TASK_CONTEXT_TTL_MS
    : session?.pendingPixRequest?.requestedAt
      ? COPILOT_PIX_CONTEXT_TTL_MS
      : COPILOT_PENDING_TTL_MS;
  if (!Number.isFinite(createdAt) || nowMs - createdAt > contextTtl || nowMs < createdAt - 60_000) {
    session.pendingCopilotTask = null;
    return null;
  }
  // A generic clarification must never become a sticky task. It can otherwise
  // contaminate the next independent request and force an unnecessary
  // continuation-vs-new-request clarification.
  if (String(task.type || '').trim().toLowerCase() === 'general') {
    session.pendingCopilotTask = null;
    return null;
  }
  return task;
}

export function similarClarification(a = '', b = '') {
  const tokens = value => [...new Set(normalize(value).split(/\s+/).filter(token => token.length > 2 && !QUESTION_STOP_WORDS.has(token)))];
  const left = tokens(a);
  const right = tokens(b);
  if (!left.length || !right.length) return false;
  const common = left.filter(token => right.includes(token)).length;
  const overlap = common / Math.min(left.length, right.length);
  const union = common / new Set([...left, ...right]).size;
  return common >= 2 && (overlap >= 0.72 || union >= 0.62);
}

export function extractContactSaveArgs(text = '') {
  const source = String(text || '').trim();
  const phoneMatch = source.match(/(?:\+?55[\s().-]*)?\d(?:[\s().-]*\d){7,14}\s*$/);
  if (!phoneMatch) return null;

  const telefone = phoneMatch[0].trim();
  let nome = source.slice(0, phoneMatch.index).trim();
  nome = nome
    .replace(/(?:[,;]|\s+)\s*(?:telefone|celular|fone)\s*[:=-]\s*$/i, '')
    .replace(/[,;:|\-\s]+$/g, '')
    .replace(/^\s*(?:nome|contato)\s*[:=-]\s*/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 100);

  if (nome.length < 2) return null;
  return { nome, telefone };
}

export function extractCurrentPixArgs(text = '', { allowBareNumber = false } = {}) {
  const source = String(text || '');
  const free = /\b(?:valor\s+livre|livre|sem\s+valor|qualquer\s+valor)\b/i.test(source);
  let price = detectPriceMentions(source)[0];
  if (!price) {
    const reaisIndex = source.search(/\breais?\b/i);
    if (reaisIndex >= 0) {
      const prefixWords = source.slice(0, reaisIndex).trim().split(/\s+/).filter(Boolean);
      for (let start = Math.max(0, prefixWords.length - 6); start < prefixWords.length; start += 1) {
        const candidate = `${prefixWords.slice(start).join(' ')} reais`;
        price = detectPriceMentions(candidate)[0];
        if (price) break;
      }
    }
  }
  let amount = price ? price.cents / 100 : null;
  let rawAmount = price?.raw || '';
  if (amount === null && allowBareNumber) {
    const match = source.match(/(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/i);
    if (match) {
      amount = normalizePixAmount(`${match[1]}${match[2] !== undefined ? `,${match[2]}` : ''}`);
      rawAmount = match[0];
    }
  }

  let description = source;
  if (rawAmount) description = description.replace(new RegExp(rawAmount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  description = description
    .replace(/\b(?:valor\s+livre|livre|sem\s+valor|qualquer\s+valor)\b/ig, ' ')
    .replace(/^\s*(?:lia[,!: -]*)?(?:(?:quero|preciso|pode|gostaria\s+de)\s+)?(?:cobrar|gerar|criar|fazer|emitir)\s+(?:uma?\s+)?(?:cobran[cç]a\s+)?/i, '')
    .replace(/^\s*(?:pix|cobran[cç]a(?:\s+pix)?)(?:\s+de)?\b/i, '')
    .replace(/^\s*(?:sobre|para|pra|por|pela|pelo|referente(?:\s+a)?|de|do|da)\s+/i, '')
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '')
    .trim()
    .slice(0, 80);

  return {
    hasAmountOrFree: amount !== null || free,
    isFreeAmount: free,
    valor: free ? 0 : amount,
    descricao: description
  };
}

export function isValidPixDescription(value = '') {
  const description = String(value || '').trim().replace(/\s+/g, ' ');
  if (description.length < 2 || description.length > 80 || /[?¿]/.test(description)) return false;
  if (/\b(?:o que|por que|porque|como assim|qual|quais|vc|você|voce|nao entendi|não entendi|bom dia|boa tarde|boa noite|me explica|me explique)\b/i.test(description)) return false;
  return true;
}

export function parseNaturalControlResult(result) {
  const raw = String(result?.text || result?.reply || result?.content || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const intent = String(parsed.intent || '').trim().toLowerCase();
    const allowed = new Set(['resume_bot', 'activate_human', 'list_queue', 'status', 'clear_history', 'none']);
    if (!allowed.has(intent) || intent === 'none') return null;
    return {
      intent,
      target: String(parsed.target || '').trim().slice(0, 80),
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0
    };
  } catch {
    return null;
  }
}

export function resolveNaturalTarget(target, { pendingReactivation, waiting }) {
  const raw = String(target || '').trim();
  const normalized = normalize(raw);
  if (!normalized) return '';
  if (/^(?:um|uma|o|a)?\s*(?:atendimento|contato|cliente|conversa|pessoa)$/.test(normalized)) return '';
  if (/^(?:primeir[oa]|primeir[oa] da fila|primeir[oa] em espera)$/.test(normalized)) return '1';
  if (/^(?:segund[oa]|segund[oa] da fila|segund[oa] em espera)$/.test(normalized)) return '2';
  if (/^(?:ultim[oa]|ultim[oa] da fila|ultim[oa] em espera)$/.test(normalized)) return waiting.length ? String(waiting.length) : '';
  if (/^(?:ess[ae]|est[ae]|essa conversa|esta conversa|esse cliente|este cliente|conversa atual|cliente atual)$/.test(normalized)) {
    if (pendingReactivation?.phone) return pendingReactivation.phone;
    return waiting.length === 1 ? String(waiting[0].phone || '') : '';
  }
  return raw;
}

export async function classifyNaturalControl({ ai, botConfig, text, pendingReactivation, deadline }) {
  if (!ai?.askAI || !NATURAL_CONTROL_HINT.test(text)) return null;
  const prompt = [
    'Interprete apenas pedidos operacionais do responsável por um bot de WhatsApp.',
    'Responda somente JSON válido neste formato: {"intent":"resume_bot|activate_human|list_queue|status|clear_history|none","target":"nome, telefone ou vazio","confidence":0.0}',
    'resume_bot: devolver a conversa para a Lia, retomar ou deixar o bot continuar.',
    'activate_human: assumir pessoalmente, pausar o bot ou manter atendimento humano.',
    'list_queue: perguntar quem está aguardando ou mostrar a fila.',
    'status: perguntar situação, saúde ou funcionamento do sistema.',
    'clear_history: apagar, limpar ou resetar o histórico de uma conversa.',
    'Use none para mensagens que não sejam claramente um desses pedidos. Não execute nada.',
    pendingReactivation?.phone ? `Há uma continuidade pendente para o contato ${pendingReactivation.contactLabel || pendingReactivation.phone}.` : '',
    `Mensagem do responsável: ${text}`
  ].filter(Boolean).join('\n');
  try {
    const result = await ai.askAI({
      system: prompt,
      history: [],
      userText: text,
      botConfig,
      isOwner: true,
      autoRouting: false,
      deadline
    });
    return parseNaturalControlResult(result);
  } catch {
    return null;
  }
}
