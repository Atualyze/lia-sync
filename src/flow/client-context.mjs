const DEFAULT_TOPIC_GAP_MS = 2 * 60 * 60 * 1000;

const CONTEXT_STOP_WORDS = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em',
  'na', 'nas', 'no', 'nos', 'o', 'os', 'para', 'pela', 'pelas', 'pelo',
  'pelos', 'por', 'pra', 'pro', 'um', 'uma', 'uns', 'umas', 'que', 'qual',
  'quais', 'como', 'quando', 'onde', 'eu', 'voce', 'voces', 'me', 'meu',
  'minha', 'meus', 'minhas', 'nos', 'nosso', 'nossa', 'seu', 'sua', 'seus',
  'suas', 'vamos', 'podemos', 'poderia', 'gostaria', 'queria', 'sobre', 'falamos', 'conversamos', 'combinamos', 'discutimos', 'retoma', 'retomar', 'retome', 'volta', 'voltar', 'volte',
  'continua', 'continuar', 'continue', 'recupera', 'recuperar', 'lembra',
  'lembrar', 'lembre', 'conversa', 'conversas', 'assunto', 'assuntos',
  'projeto', 'projetos', 'anterior', 'anteriores', 'antiga', 'antigo',
  'ontem', 'hoje', 'semana', 'passada', 'passado', 'dias', 'atras',
  'aquela', 'aquele', 'aquilo', 'ultima', 'ultimo', 'vez', 'vezes'
]);

function normalizeContextText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contextTokens(value = '') {
  return normalizeContextText(value)
    .split(' ')
    .filter(token => token.length >= 3 && !CONTEXT_STOP_WORDS.has(token));
}

function latestAssistantText(history = []) {
  const items = Array.isArray(history) ? history : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.role === 'assistant') return String(items[i]?.content || '');
  }
  return '';
}

export function lastAssistantAskedForPayment(history = [], pendingQuestion = '') {
  const text = normalizeContextText(pendingQuestion || latestAssistantText(history));
  const mentionsPayment = /\b(?:pix|copia e cola|codigo|cobranca|pagamento|checkout|chave)\b/.test(text);
  const asksChoiceOrAmount = /\b(?:qual|quanto|informe|prefere|escolhe|escolher|valor|opcao|opcoes|deseja)\b/.test(text)
    || text.includes('?');
  return mentionsPayment && asksChoiceOrAmount;
}

export function lastAssistantAskedForPaymentAmount(history = [], pendingQuestion = '') {
  const text = normalizeContextText(pendingQuestion || latestAssistantText(history));
  return /\b(?:valor|quanto)\b/.test(text)
    && /\b(?:pix|copia e cola|codigo|cobranca|pagamento|checkout)\b/.test(text)
    && (text.includes('?') || /\b(?:informe|me diga|qual)\b/.test(text));
}

export function lastAssistantAskedForAgendaConfirmation(history = [], pendingQuestion = '') {
  const text = normalizeContextText(pendingQuestion || latestAssistantText(history));
  const mentionsAgenda = /\b(?:agenda|agendar|agendamento|horario|reuniao|compromisso)\b/.test(text);
  return mentionsAgenda
    && /\b(?:confirmar|confirma|posso|pode|agendar|marcar)\b/.test(text)
    && (text.includes('?') || /\b(?:confirma|posso confirmar)\b/.test(text));
}

function messageTime(message) {
  const value = message?.createdAt || message?.created_at || message?.timestamp || null;
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Builds a narrow retrieval query from the current request and only the closest
 * conversational turns. Older episodes must not make unrelated memories look relevant.
 */
export function buildMemoryRetrievalQuery(currentText = '', recentHistory = [], {
  maxContextMessages = 4,
  maxChars = 2200
} = {}) {
  const previous = (Array.isArray(recentHistory) ? recentHistory : [])
    .filter(message => String(message?.content || '').trim())
    .slice(-Math.max(0, Math.min(8, Number(maxContextMessages) || 4)))
    .map(message => `${message.role === 'assistant' ? 'assistant' : 'user'}: ${String(message.content || '').trim()}`);
  return [...previous, `current: ${String(currentText || '').trim()}`]
    .filter(Boolean)
    .join('\n')
    .slice(-Math.max(200, Number(maxChars) || 2200));
}

/**
 * Detects an explicit request to revisit an earlier conversation. Ordinary
 * follow-ups such as "o que houve?" remain attached to the active thread.
 */
export function isExplicitHistoryRecallRequest(value = '') {
  const text = normalizeContextText(value);
  if (!text) return false;
  const asksToResume = /\b(?:retoma|retomar|retome|volta|voltar|volte|continua|continuar|continue|recupera|recuperar|lembra|lembrar|lembre)\b/.test(text);
  const referencesHistory = /\b(?:conversa|conversas|assunto|assuntos|projeto|projetos|anterior|anteriores|antiga|antigo|ontem|semana|passada|passado|dias|atras|aquela|aquele|ultima|ultimo|vez|site|oficina|orcamento|proposta)\b/.test(text);
  return (asksToResume && referencesHistory)
    || /\b(?:o que|qual|como)\b.{0,70}\b(?:falamos|conversamos|combinamos|ficou definido)\b/.test(text)
    || /\b(?:de onde paramos|onde paramos|na ultima conversa|na conversa anterior)\b/.test(text);
}

/**
 * Finds a small, relevant excerpt from prior conversations for an explicit
 * recall request. Results are kept separate from the active conversation.
 */
export function selectRelevantConversationContext(history = [], query = '', {
  maxMessages = 10
} = {}) {
  const all = Array.isArray(history) ? history.filter(message => String(message?.content || '').trim()) : [];
  const queryTokens = [...new Set(contextTokens(query))];
  if (!all.length || !queryTokens.length) {
    return { matched: false, messages: [], reason: 'insufficient_topic' };
  }

  const groups = new Map();
  for (const message of all) {
    const key = String(message?.conversationId || message?._conversationId || 'active');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }

  const candidates = [];
  for (const [conversationId, rawMessages] of groups) {
    const messages = rawMessages
      .map((message, index) => ({ message, index, time: messageTime(message) }))
      .sort((a, b) => (a.time ?? a.index) - (b.time ?? b.index));
    const combinedTokens = new Set(messages.flatMap(item => contextTokens(item.message.content)));
    const hits = queryTokens.filter(token => combinedTokens.has(token));
    const minimumHits = queryTokens.length === 1 ? 1 : Math.max(2, Math.ceil(queryTokens.length * 0.35));
    if (hits.length < minimumHits) continue;

    let lastRelevantIndex = -1;
    for (let i = 0; i < messages.length; i += 1) {
      const tokens = new Set(contextTokens(messages[i].message.content));
      if (hits.some(token => tokens.has(token))) lastRelevantIndex = i;
    }
    candidates.push({
      conversationId,
      messages,
      score: hits.length / queryTokens.length,
      lastRelevantIndex,
      latestTime: messages.at(-1)?.time || 0
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.latestTime - a.latestTime);
  const best = candidates[0];
  if (!best || best.lastRelevantIndex < 0) {
    return { matched: false, messages: [], reason: 'no_relevant_history' };
  }

  const limit = Math.max(4, Math.min(16, Number(maxMessages) || 10));
  const start = Math.max(0, Math.min(best.lastRelevantIndex - 3, best.messages.length - limit));
  const selected = best.messages
    .slice(start, Math.min(best.messages.length, start + limit))
    .map(item => ({
      role: item.message.role === 'assistant' ? 'assistant' : 'user',
      content: String(item.message.content || '').slice(0, 1200),
      ...(item.message.createdAt || item.message.created_at
        ? { createdAt: item.message.createdAt || item.message.created_at }
        : {})
    }));

  return {
    matched: selected.length > 0,
    messages: selected,
    conversationId: best.conversationId,
    reason: 'relevant_history_found'
  };
}

/**
 * Selects the active conversational episode without deleting or mutating the
 * stored history. Long pauses separate active context; explicit historical
 * recall is handled independently by selectRelevantConversationContext.
 */
export function selectActiveClientHistory(history = [], {
  maxTurns = 24,
  nowMs = Date.now(),
  topicGapMs = DEFAULT_TOPIC_GAP_MS,
  preservePendingContext = false
} = {}) {
  const all = Array.isArray(history) ? history : [];
  if (all.length === 0) return { history: [], topicBoundary: false, boundaryIndex: 0 };

  let boundaryIndex = 0;
  if (!preservePendingContext) {
    for (let i = all.length - 1; i > 0; i -= 1) {
      const currentTime = messageTime(all[i]);
      const previousTime = messageTime(all[i - 1]);
      if (currentTime === null || previousTime === null) continue;
      if (currentTime - previousTime > topicGapMs && currentTime <= nowMs + 60_000) {
        boundaryIndex = i;
        break;
      }
    }
  }

  const limit = Math.max(1, Math.min(100, Number(maxTurns) || 24));
  const active = all.slice(boundaryIndex);
  return {
    history: active.slice(-limit),
    topicBoundary: boundaryIndex > 0,
    boundaryIndex
  };
}
