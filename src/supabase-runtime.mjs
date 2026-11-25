import crypto from 'node:crypto';
import { SessionStore, normalizePhone } from './sessions.mjs';
import { AdminConfigStore, DEFAULT_BOT_CONFIG, merge, normalizeBotConfig } from './admin-config.mjs';

const jsonClone = value => JSON.parse(JSON.stringify(value));
const iso = value => value ? new Date(value).toISOString() : null;
const normalizePendingClientPayment = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let createdAt;
  try { createdAt = iso(value.createdAt); } catch { return null; }
  if (!createdAt) return null;
  const sourceArgs = value.args && typeof value.args === 'object' && !Array.isArray(value.args) ? value.args : {};
  const args = {};
  const rawAmount = sourceArgs.valor;
  if (typeof rawAmount === 'number' && Number.isFinite(rawAmount) && rawAmount >= 0) args.valor = rawAmount;
  else if (typeof rawAmount === 'string' && /^\d+(?:[.,]\d{1,2})?$/.test(rawAmount.trim())) args.valor = Number(rawAmount.trim().replace(',', '.'));
  const description = typeof sourceArgs.descricao === 'string' ? sourceArgs.descricao.trim().slice(0, 80) : '';
  if (description) args.descricao = description;
  const choice = value.choice === 'pix' || value.choice === 'checkout' ? value.choice : null;
  const lastQuestion = typeof value.lastQuestion === 'string' ? value.lastQuestion.slice(0, 320) : '';
  let pausedAt = null;
  if (value.pausedAt) {
    try { pausedAt = iso(value.pausedAt); } catch { pausedAt = null; }
  }
  return { args, choice, createdAt, ...(lastQuestion ? { lastQuestion } : {}), ...(pausedAt ? { pausedAt } : {}) };
};
const normalizePendingAdminDecision = value => {
  const statuses = new Set(['pending', 'processing', 'completed', 'assumed', 'failed', 'uncertain', 'expired']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'pix_generation' || !statuses.has(value.status)) return null;
  let requestedAt;
  try { requestedAt = iso(value.requestedAt); } catch { return null; }
  const amount = Number(value.amount);
  if (!requestedAt || !Number.isFinite(amount) || amount <= 0) return null;
  const optionalIso = key => {
    if (!value[key]) return undefined;
    try { return iso(value[key]) || undefined; } catch { return undefined; }
  };
  return {
    type: 'pix_generation',
    status: value.status,
    amount: Number(amount.toFixed(2)),
    description: String(value.description || 'Pagamento via Pix').trim().slice(0, 80),
    paymentMethod: 'pix_copy_paste',
    requestedAt,
    ...(typeof value.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(value.requestId.trim())
      ? { requestId: value.requestId.trim() }
      : {}),
    ...(optionalIso('decidedAt') ? { decidedAt: optionalIso('decidedAt') } : {}),
    ...(optionalIso('completedAt') ? { completedAt: optionalIso('completedAt') } : {}),
    ...(typeof value.decidedBy === 'string' && value.decidedBy.trim() ? { decidedBy: value.decidedBy.trim().slice(0, 80) } : {}),
    ...(typeof value.error === 'string' && value.error.trim() ? { error: value.error.trim().slice(0, 180) } : {})
  };
};
const normalizePendingCopilotTask = value => {
  const allowed = new Set(['general', 'payment', 'followup', 'dispatch', 'agenda', 'document', 'drive', 'sheet', 'public_data', 'crm', 'contact', 'memory', 'infra', 'web', 'knowledge', 'handoff']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !allowed.has(value.type)) return null;
  let createdAt;
  try { createdAt = iso(value.createdAt); } catch { return null; }
  if (!createdAt) return null;
  return {
    type: value.type,
    createdAt,
    updatedAt: (() => { try { return iso(value.updatedAt) || createdAt; } catch { return createdAt; } })(),
    originCommand: typeof value.originCommand === 'string' ? value.originCommand.slice(0, 500) : '',
    lastQuestion: typeof value.lastQuestion === 'string' ? value.lastQuestion.slice(0, 500) : '',
    repeatCount: Math.max(0, Math.min(2, Number(value.repeatCount) || 0)),
    turns: Math.max(0, Math.min(10, Number(value.turns) || 0)),
    allowedTools: Array.isArray(value.allowedTools)
      ? [...new Set(value.allowedTools.filter(name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(name)))].slice(0, 8)
      : [],
    ...(typeof value.taskId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.taskId)
      ? { taskId: value.taskId }
      : {}),
    ...(['queued', 'running', 'awaiting_input', 'succeeded', 'failed', 'uncertain', 'cancelled'].includes(value.taskStatus)
      ? { taskStatus: value.taskStatus }
      : {})
  };
};
// Logs não podem conter telefone completo (regra do projeto).
const maskKey = value => {
  const raw = String(value || '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return raw ? '***' : '';
  return `${raw.startsWith('sim:') ? 'sim:' : ''}${digits.slice(0, 4)}***${digits.slice(-2)}`;
};

export class SupabaseRestClient {
  constructor({ url, key, logger = console, timeoutMs = Number(process.env.SUPABASE_REQUEST_TIMEOUT_MS) || 12000 } = {}) {
    this.url = String(url || '').replace(/\/$/, '');
    this.key = key || '';
    this.logger = logger;
    this.timeoutMs = Math.max(1000, Math.min(60000, Number(timeoutMs) || 12000));
    this.enabled = Boolean(this.url && this.key);
  }

  async request(table, { method = 'GET', query = '', body, prefer = '' } = {}) {
    if (!this.enabled) throw new Error('Supabase runtime não configurado');
    const response = await fetch(`${this.url}/rest/v1/${table}${query ? `?${query}` : ''}`, {
      method,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        'content-type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {})
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(`Supabase ${method} ${table} HTTP ${response.status}: ${data?.message || data?.hint || text || 'erro desconhecido'}`);
    return data;
  }

  async select(table, query) { return this.request(table, { query }); }
  async upsert(table, rows, onConflict, { returnRepresentation = true } = {}) {
    const returnMode = returnRepresentation ? 'return=representation' : 'return=minimal';
    return this.request(table, {
      method: 'POST',
      query: onConflict ? `on_conflict=${encodeURIComponent(onConflict)}` : '',
      body: rows,
      prefer: `resolution=merge-duplicates,${returnMode}`
    });
  }
  async insert(table, rows) { return this.request(table, { method: 'POST', body: rows, prefer: 'return=minimal' }); }
  async patch(table, query, body, { returnRepresentation = true } = {}) {
    const returnMode = returnRepresentation ? 'return=representation' : 'return=minimal';
    return this.request(table, { method: 'PATCH', query, body, prefer: returnMode });
  }
  async rpc(name, args = {}) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error('Supabase RPC inválida');
    return this.request(`rpc/${name}`, { method: 'POST', body: args });
  }
}

const externalIdFor = (key, _index, message) => {
  if (message.id) {
    const id = String(message.id);
    return id.startsWith('runtime:') || id.startsWith('wa:') ? id : `wa:${id}`;
  }
  const tsPart = message.createdAt ? String(message.createdAt).slice(0, 19) : 'nodate';
  const hash = crypto.createHash('sha1').update(`${message.role}:${tsPart}:${String(message.content || '').trim()}`).digest('hex').slice(0, 16);
  return `runtime:${key}:${tsPart}:${hash}`;
};

function messageTimestampMs(m) {
  const ts = Date.parse(m?.createdAt || m?.created_at || '');
  return Number.isFinite(ts) ? ts : 0;
}

function latestSessionActivityMs(s) {
  if (!s || typeof s !== 'object') return 0;
  const hist = Array.isArray(s.history) ? s.history : [];
  const lastHistMs = hist.reduce((max, m) => Math.max(max, messageTimestampMs(m)), 0);
  const candidates = [
    lastHistMs,
    Date.parse(s.lastUserAt || ''),
    Date.parse(s.lastBotAt || ''),
    Date.parse(s.updatedAt || ''),
    Date.parse(s.createdAt || '')
  ];
  return candidates.reduce((max, v) => (Number.isFinite(v) && v > max ? v : max), 0);
}

function canonicalMessageId(rawId = '') {
  return String(rawId || '').replace(/^wa:/i, '').trim();
}

export function dedupeMessages(messages = []) {
  const indexed = [];
  const seenIds = new Set();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || !m.content) continue;
    const idStr = canonicalMessageId(m.id);
    if (idStr && seenIds.has(idStr)) continue;
    const normContent = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (!normContent) continue;
    const ts = messageTimestampMs(m);
    // Deduplica duplicatas sem ID (ou mesclagem local+remoto) com mesmo papel e conteúdo em janela de 15s
    const dupIdx = indexed.findIndex(item => {
      if (item.m.role !== m.role) return false;
      if (item.normContent !== normContent) return false;
      if (idStr && item.idStr && idStr !== item.idStr) return false;
      if (ts && item.ts && Math.abs(ts - item.ts) > 15_000) return false;
      return true;
    });
    if (dupIdx >= 0) {
      // Prefere a versão que possui ID/timestamp mais completo
      const prev = indexed[dupIdx];
      if ((!prev.idStr && idStr) || (!prev.ts && ts)) {
        if (idStr) seenIds.add(idStr);
        indexed[dupIdx] = { m: { ...prev.m, ...m }, idStr: idStr || prev.idStr, normContent, ts: ts || prev.ts, order: prev.order };
      }
      continue;
    }
    if (idStr) seenIds.add(idStr);
    indexed.push({ m, idStr, normContent, ts, order: i });
  }
  indexed.sort((a, b) => {
    if (a.ts && b.ts && a.ts !== b.ts) return a.ts - b.ts;
    return a.order - b.order;
  });
  return indexed.map(item => item.m);
}

function rowToSession(row, messages = []) {
  const c = row.contacts || {};
  const meta = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};
  const key = row.external_key;
  const resolvedName = row.contact_name || c.display_name || c.push_name || '';
  const cleanMessages = dedupeMessages(
    messages.map(m => {
      const mMeta = (m.metadata && typeof m.metadata === 'object') ? m.metadata : {};
      return {
        role: m.role,
        content: m.content,
        createdAt: m.created_at || null,
        ...(m.external_id ? { id: m.external_id } : {}),
        deliveryStatus: m.delivery_status || null,
        messageType: m.message_type || 'text',
        ...(mMeta.replyTo ? { replyTo: mMeta.replyTo } : {}),
        ...(mMeta.mediaType ? { mediaType: mMeta.mediaType } : {}),
        ...(mMeta.fileName ? { fileName: mMeta.fileName } : {}),
        ...(mMeta.fromCopilot ? { fromCopilot: true } : {})
      };
    })
  );
  return {
    phone: c.phone || key.replace(/^sim:/, ''),
    origin: row.origin,
    _conversationId: row.id || null,
    _contactId: row.contact_id || c.id || null,
    history: cleanMessages,
    human: row.mode === 'human',
    humanSource: row.human_source || null,
    updatedAt: iso(row.updated_at),
    clientName: resolvedName,
    contactName: resolvedName,
    pushName: c.push_name || '',
    jid: meta.jid || undefined,
    supportModeEnabled: Boolean(meta.supportModeEnabled),
    knowledgeBaseId: meta.knowledgeBaseId || null,
    instancePhone: meta.instancePhone || null,
    contactRole: meta.contactRole || null,
    contactNotes: meta.contactNotes || meta.crmNotes || meta.notes || '',
    crmNotes: meta.crmNotes || meta.contactNotes || meta.notes || '',
    notes: meta.notes || meta.crmNotes || meta.contactNotes || '',
    productInterest: meta.productInterest || '',
    dealStage: meta.dealStage || '',
    audioPreference: meta.audioPreference || undefined,
    askedAudioPreference: Boolean(meta.askedAudioPreference),
    pendingPixRequest: meta.pendingPixRequest && typeof meta.pendingPixRequest === 'object' && !Array.isArray(meta.pendingPixRequest)
      ? { ...meta.pendingPixRequest }
      : null,
    pendingCopilotTask: normalizePendingCopilotTask(meta.pendingCopilotTask),
    pendingOutboundDispatch: meta.pendingOutboundDispatch && typeof meta.pendingOutboundDispatch === 'object' && !Array.isArray(meta.pendingOutboundDispatch)
      ? { ...meta.pendingOutboundDispatch }
      : null,
    pendingClientPayment: normalizePendingClientPayment(meta.pendingClientPayment),
    pendingAdminDecision: normalizePendingAdminDecision(meta.pendingAdminDecision),
    pendingAdminConsult: meta.pendingAdminConsult && typeof meta.pendingAdminConsult === 'object' ? { ...meta.pendingAdminConsult } : null,
    pendingCheckout: meta.pendingCheckout && typeof meta.pendingCheckout === 'object' && !Array.isArray(meta.pendingCheckout)
      ? { ...meta.pendingCheckout }
      : null,
    followUpPendingId: meta.followUpPendingId || null,
    lastIntent: row.last_intent || undefined,
    intents: row.intents || [],
    awaitingReply: Boolean(row.awaiting_reply),
    inactivityStage: row.inactivity_stage || 0,
    inactivityClosed: Boolean(row.inactivity_closed),
    sendFailed: Boolean(row.send_failed),
    violationsCount: row.violations_count || 0,
    fallbackHandoffAt: row.fallback_handoff_at ? new Date(row.fallback_handoff_at).getTime() : undefined,
    handoffAt: iso(row.handoff_at),
    handoffReason: row.handoff_reason || undefined,
    handoffUrgency: row.handoff_urgency || undefined,
    handoffNotified: Boolean(row.handoff_notified),
    handoffNotifyFailed: Boolean(row.handoff_notify_failed),
    handoffReminderAt: row.handoff_reminder_at ? new Date(row.handoff_reminder_at).getTime() : undefined,
    handoffReminder1Sent: Boolean(row.handoff_reminder1_sent),
    handoffReminder60Sent: Boolean(row.handoff_reminder60_sent),
    lastUserAt: iso(row.last_user_at),
    lastBotAt: iso(row.last_bot_at),
    followUpCount: Number(row.follow_up_count ?? meta.followUpCount ?? 0),
    followUpSentAt: iso(row.follow_up_sent_at || meta.followUpSentAt),
    followUpClaimedAt: iso(row.follow_up_claimed_at || meta.followUpClaimedAt),
    followUpClaimToken: row.follow_up_claim_token || null,
    archivedAt: iso(row.archived_at),
    status: row.status,
    archiveReason: row.archive_reason || undefined,
    legalHold: Boolean(meta.legalHold || meta.legal_hold),
    _conversationId: row.id,
    _contactId: row.contact_id || null,
    _externalKey: key
  };
}

function sessionToConversation(key, session, contactId) {
  const date = value => value instanceof Date ? value.toISOString() : (typeof value === 'number' ? new Date(value).toISOString() : value || null);
  const validHumanSources = new Set(['takeover', 'dashboard', 'resume', 'admin', 'auto-resume']);
  let hSource = session.human ? (session.humanSource || 'admin') : null;
  if (hSource === 'admin_command') hSource = 'admin';
  if (hSource === 'operator_command') hSource = 'takeover';
  if (hSource && !validHumanSources.has(hSource)) hSource = 'admin';

  return {
    contact_id: contactId ?? session._contactId ?? null,
    external_key: key,
    origin: session.origin === 'simulation' || key.startsWith('sim:') ? 'simulation' : 'real',
    status: session.status === 'closed' ? 'closed' : (session.archivedAt ? 'archived' : 'open'),
    mode: session.human ? 'human' : 'bot',
    human_source: hSource,
    contact_name: session.clientName || session.contactName || null,
    last_intent: session.lastIntent || null,
    intents: Array.isArray(session.intents) ? session.intents : [],
    awaiting_reply: Boolean(session.awaitingReply),
    inactivity_stage: Number(session.inactivityStage || 0),
    inactivity_closed: Boolean(session.inactivityClosed),
    send_failed: Boolean(session.sendFailed),
    violations_count: Number(session.violationsCount || 0),
    fallback_handoff_at: date(session.fallbackHandoffAt),
    handoff_at: date(session.handoffAt),
    handoff_reason: session.handoffReason || null,
    handoff_urgency: session.handoffUrgency || null,
    handoff_notified: Boolean(session.handoffNotified),
    handoff_notify_failed: Boolean(session.handoffNotifyFailed),
    handoff_reminder_at: date(session.handoffReminderAt),
    handoff_reminder1_sent: Boolean(session.handoffReminder1Sent),
    handoff_reminder60_sent: Boolean(session.handoffReminder60Sent),
    last_user_at: date(session.lastUserAt),
    last_bot_at: date(session.lastBotAt),
    follow_up_count: Number(session.followUpCount || 0),
    follow_up_sent_at: date(session.followUpSentAt),
    // follow_up_claimed_at / follow_up_claim_token são de propriedade do banco (RPC
    // claim/complete/release). Gravá-los aqui reintroduziria o estado local de outra
    // réplica e derrubaria a claim ativa, causando envio duplicado de follow-up.
    archived_at: date(session.archivedAt),
    archive_reason: session.archiveReason || null,
    // legal_hold é coluna dedicada: o flush só ELEVA o hold, nunca o limpa,
    // para que a retenção não apague dado sob hold por causa de estado local velho.
    ...(session.legalHold ? { legal_hold: true } : {}),
    metadata: {
      runtime: 'node',
      role: 'lia-assistant',
      jid: session.jid || null,
      supportModeEnabled: Boolean(session.supportModeEnabled),
      knowledgeBaseId: session.knowledgeBaseId || null,
      instancePhone: session.instancePhone || null,
      contactRole: session.contactRole || null,
      contactNotes: session.contactNotes || session.crmNotes || session.notes || '',
      crmNotes: session.crmNotes || session.contactNotes || session.notes || '',
      notes: session.notes || session.crmNotes || session.contactNotes || '',
      productInterest: session.productInterest || '',
      dealStage: session.dealStage || '',
      audioPreference: session.audioPreference || null,
      askedAudioPreference: Boolean(session.askedAudioPreference),
      pendingPixRequest: session.pendingPixRequest && typeof session.pendingPixRequest === 'object'
        ? { ...session.pendingPixRequest }
        : null,
      pendingCopilotTask: normalizePendingCopilotTask(session.pendingCopilotTask),
      pendingOutboundDispatch: session.pendingOutboundDispatch && typeof session.pendingOutboundDispatch === 'object'
        ? { ...session.pendingOutboundDispatch }
        : null,
      pendingClientPayment: normalizePendingClientPayment(session.pendingClientPayment),
      pendingAdminDecision: normalizePendingAdminDecision(session.pendingAdminDecision),
      pendingAdminConsult: session.pendingAdminConsult && typeof session.pendingAdminConsult === 'object' ? { ...session.pendingAdminConsult } : null,
      pendingCheckout: session.pendingCheckout && typeof session.pendingCheckout === 'object'
        ? { ...session.pendingCheckout }
        : null,
      followUpPendingId: session.followUpPendingId || null,
      followUpCount: Number(session.followUpCount || 0),
      followUpSentAt: date(session.followUpSentAt)
    },
  };
}


function contactRowForSession(key, session, lastSeenAt = null) {
  const externalId = key.replace(/^sim:/, '');
  const resolvedName = session.clientName || session.contactName || session.pushName || null;
  return {
    channel: 'whatsapp',
    external_id: externalId,
    phone: /^\\d{8,15}$/.test(externalId) ? externalId : null,
    display_name: resolvedName,
    push_name: session.pushName || resolvedName,
    last_seen_at: session.lastUserAt || lastSeenAt || session.updatedAt || new Date().toISOString()
  };
}

function messageRowForSession(key, conversationId, index, message) {
  const createdAt = message.createdAt || message.created_at || new Date().toISOString();
  if (!message.createdAt) message.createdAt = createdAt;
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const replyTo = message.replyTo || metadata.replyTo;
  const mediaType = message.mediaType || metadata.mediaType;
  const fileName = message.fileName || metadata.fileName;
  const fromCopilot = Boolean(message.fromCopilot || metadata.fromCopilot);
  return {
    conversation_id: conversationId,
    external_id: externalIdFor(key, index, message),
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message.content || ''),
    message_type: message.messageType || 'text',
    from_me: message.role === 'assistant',
    delivery_status: message.deliveryStatus || (message.role === 'assistant' ? 'sent' : 'received'),
    created_at: createdAt,
    metadata: {
      runtime: 'node',
      ...(replyTo ? { replyTo } : {}),
      ...(mediaType ? { mediaType } : {}),
      ...(fileName ? { fileName } : {}),
      ...(fromCopilot ? { fromCopilot: true } : {})
    }
  };
}

function remoteFlushStateForSession(key, row, session, messages = []) {
  const state = {
    conversationId: row.id || null,
    contactId: row.contact_id || row.contacts?.id || session._contactId || null,
    lastSeenAt: row.contacts?.last_seen_at || row.last_user_at || row.updated_at || null,
    contactSignature: null,
    conversationSignature: null,
    messages: new Map()
  };
  if (state.contactId && !key.startsWith('sim:')) {
    state.contactSignature = JSON.stringify(contactRowForSession(key, session, state.lastSeenAt));
  }
  if (state.conversationId) {
    state.conversationSignature = JSON.stringify(sessionToConversation(key, session, state.contactId));
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message?.external_id) continue;
    const normalized = {
      id: message.external_id,
      role: message.role,
      content: message.content,
      createdAt: message.created_at,
      deliveryStatus: message.delivery_status,
      messageType: message.message_type,
      metadata: message.metadata || {}
    };
    const payload = messageRowForSession(key, state.conversationId, index, normalized);
    state.messages.set(payload.external_id, JSON.stringify(payload));
  }
  return state;
}

export class SupabaseSessionStore extends SessionStore {
  constructor(file, { client, logger = console, ...options } = {}) {
    super(file, { logger, ...options });
    this.client = client;
    this.logger = logger;
    this.persistence = 'fallback';
    this.remoteError = null;
    this.refreshing = null;
    this.lastRefreshAt = 0;
    this.initialSyncDone = false;
    this.lastRetentionSweepAt = 0;
    this.lidMap = new Map();
    // Assinaturas de dados remotos: impedem regravar contatos, conversas e
    // mensagens já persistidos a cada flush local.
    this.remoteFlushState = new Map();
  }

  rememberLid(jid, phone) {
    const cleanJid = String(jid || '').trim();
    const cleanPhone = normalizePhone(phone);
    if (!/@lid$/i.test(cleanJid) || !cleanPhone || /@lid$/i.test(cleanPhone)) return;
    this.lidMap.set(cleanJid, cleanPhone);
    const existing = this.sessions?.[cleanPhone];
    if (existing && existing.jid !== cleanJid) {
      existing.jid = cleanJid;
      this.markDirty?.();
    }
  }

  /**
   * Loads a bounded amount of prior conversation history for the same contact.
   * This method is called only after an explicit request to revisit an old topic.
   */
  async searchContactConversationHistory(session, {
    conversationLimit = 20,
    messageLimit = 400
  } = {}) {
    const contactId = String(session?._contactId || '').trim();
    if (!this.client?.enabled || !contactId) return [];

    const maxConversations = Math.max(1, Math.min(30, Number(conversationLimit) || 20));
    const maxMessages = Math.max(20, Math.min(600, Number(messageLimit) || 400));
    let conversations;
    try {
      conversations = await this.client.select(
        'conversations',
        `select=id,updated_at,status&contact_id=eq.${encodeURIComponent(contactId)}&origin=eq.real&deleted_at=is.null&order=updated_at.desc&limit=${maxConversations}`
      );
    } catch {
      conversations = await this.client.select(
        'conversations',
        `select=id,updated_at,status&contact_id=eq.${encodeURIComponent(contactId)}&origin=eq.real&order=updated_at.desc&limit=${maxConversations}`
      ).catch(error => {
        this.logger.warn?.(`[supabase] falha ao localizar conversas anteriores do contato: ${error?.name || 'Error'}`);
        return [];
      });
    }

    const conversationIds = [...new Set((Array.isArray(conversations) ? conversations : [])
      .map(row => String(row?.id || '').trim())
      .filter(Boolean))];
    if (session?._conversationId && !conversationIds.includes(String(session._conversationId))) {
      conversationIds.unshift(String(session._conversationId));
    }
    if (!conversationIds.length) return [];

    const ids = conversationIds.slice(0, maxConversations).join(',');
    let messages;
    try {
      messages = await this.client.select(
        'conversation_messages',
        `select=conversation_id,external_id,role,content,created_at,deleted_at&conversation_id=in.(${ids})&deleted_at=is.null&order=created_at.desc&limit=${maxMessages}`
      );
    } catch {
      messages = await this.client.select(
        'conversation_messages',
        `select=conversation_id,external_id,role,content,created_at&conversation_id=in.(${ids})&order=created_at.desc&limit=${maxMessages}`
      ).catch(error => {
        this.logger.warn?.(`[supabase] falha ao recuperar histórico anterior do contato: ${error?.name || 'Error'}`);
        return [];
      });
    }

    return (Array.isArray(messages) ? messages : [])
      .filter(message => message?.conversation_id && String(message.content || '').trim())
      .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())
      .map(message => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || '').slice(0, 1200),
        createdAt: message.created_at || null,
        ...(message.external_id ? { id: message.external_id } : {}),
        conversationId: String(message.conversation_id)
      }));
  }

  async purgeArchives() {
    const localRemoved = await super.purgeArchives();
    if (!this.client?.enabled || this.now() - this.lastRetentionSweepAt < 6 * 3600000) return localRemoved;
    this.lastRetentionSweepAt = this.now();
    const cutoff = new Date(this.now() - this.ttlMs).toISOString();
    try {
      // 1) Archives expirados (status=archived + archived_at < TTL).
      const archivedRows = await this.client.select(
        'conversations',
        `select=id,status,archived_at,deleted_at,metadata&status=eq.archived&archived_at=lt.${encodeURIComponent(cutoff)}&limit=500`
      );
      for (const row of archivedRows || []) {
        const metadata = row.metadata || {};
        if (!row.id || row.status === 'closed' || metadata.legalHold || metadata.legal_hold) continue;
        const filters = new URLSearchParams({
          id: `eq.${row.id}`,
          status: 'eq.archived',
          archived_at: `lt.${cutoff}`,
          'metadata->>legalHold': 'not.is.true',
          'metadata->>legal_hold': 'not.is.true'
        });
        await this.client.request('conversations', { method: 'DELETE', query: filters.toString() });
      }
      // 2) Soft-deletes expirados: TTL também propaga a exclusão física de
      // conversas com deleted_at antigo (painel/WhatsApp), sem legal hold.
      const deletedRows = await this.client.select(
        'conversations',
        `select=id,status,deleted_at,metadata&deleted_at=lt.${encodeURIComponent(cutoff)}&limit=500`
      );
      for (const row of deletedRows || []) {
        const metadata = row.metadata || {};
        if (!row.id || row.status === 'closed' || metadata.legalHold || metadata.legal_hold) continue;
        if (!row.deleted_at) continue;
        const filters = new URLSearchParams({
          id: `eq.${row.id}`,
          deleted_at: `lt.${cutoff}`,
          'metadata->>legalHold': 'not.is.true',
          'metadata->>legal_hold': 'not.is.true'
        });
        await this.client.request('conversations', { method: 'DELETE', query: filters.toString() });
      }
      this.remoteError = null;
    } catch (error) {
      this.remoteError = error.message;
      this.logger.warn?.(`[supabase] retenção remota preservada por falha de limpeza: ${error.message}`);
    }
    return localRemoved;
  }

  async load({ isRefresh = false } = {}) {
    if (!this.client?.enabled) {
      const inMemory = { ...(this.sessions || {}) };
      await super.load();
      for (const [k, memSession] of Object.entries(inMemory)) {
        const diskSession = this.sessions[k];
        if (!diskSession) {
          this.sessions[k] = memSession;
        } else {
          const memTime = new Date(memSession.lastUserAt || memSession.lastBotAt || memSession.updatedAt || 0).getTime();
          const diskTime = new Date(diskSession.lastUserAt || diskSession.lastBotAt || diskSession.updatedAt || 0).getTime();
          if (memTime >= diskTime) {
            this.sessions[k] = memSession;
          }
        }
      }
      return this.sessions;
    }
    try {
      let rows;
      try {
        rows = await this.client.select('conversations', 'select=*,contacts(id,channel,external_id,display_name,push_name,phone,last_seen_at)&status=neq.closed&deleted_at=is.null&order=updated_at.desc&limit=500');
      } catch {
        rows = await this.client.select('conversations', 'select=*,contacts(id,channel,external_id,display_name,push_name,phone,last_seen_at)&status=neq.closed&order=updated_at.desc&limit=500');
      }
      const ids = rows.map(row => row.id).filter(Boolean);
      const grouped = new Map();
      // Chunk de 15 conversas * 60 msgs = 900 <= limite padrão de 1000 linhas do PostgREST,
      // evitando truncamento silencioso de mensagens de outras conversas no mesmo lote.
      const CHUNK_SIZE = 15;
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        const batch = await this.client.select(
          'conversation_messages',
          `select=conversation_id,external_id,role,content,created_at,deleted_at&conversation_id=in.(${chunk.join(',')})&deleted_at=is.null&order=created_at.desc&limit=${chunk.length * 60}`
        ).catch(() =>
          this.client.select(
            'conversation_messages',
            `select=conversation_id,external_id,role,content,created_at&conversation_id=in.(${chunk.join(',')})&order=created_at.desc&limit=${chunk.length * 60}`
          )
        ).catch(err => {
          this.logger.warn?.(`[supabase] falha ao buscar mensagens em lote: ${err.message}`);
          return [];
        });
        if (!Array.isArray(batch)) continue;
        // batch vem em created_at.desc (mais recentes primeiro): coleta as 60 MAIS RECENTES
        // por conversa e só depois ordena cronologicamente (antigas -> recentes).
        for (const message of batch) {
          if (!grouped.has(message.conversation_id)) grouped.set(message.conversation_id, []);
          const arr = grouped.get(message.conversation_id);
          if (arr.length < 60) arr.push(message);
        }
      }
      for (const arr of grouped.values()) {
        arr.reverse();
      }
      const remote = {};
      for (const row of rows) {
        const key = row.external_key;
        const messages = grouped.get(row.id) || [];
        const remoteSession = rowToSession(row, messages);
        remoteSession._conversationId = row.id || null;
        remoteSession._contactId = row.contact_id || row.contacts?.id || null;
        remote[key] = remoteSession;
        this.remoteFlushState.set(key, remoteFlushStateForSession(key, row, remoteSession, messages));
      }
      const local = { ...(this.sessions || {}) };
      const nextSessions = {};
      for (const [key, rSession] of Object.entries(remote)) {
        const lSession = local[key];
        if (lSession) {
          const lTime = latestSessionActivityMs(lSession);
          const rTime = latestSessionActivityMs(rSession);
          // Mescla + deduplica + ordena cronologicamente para nunca perder mensagens novas nem duplicar
          const mergedHistory = dedupeMessages([
            ...(Array.isArray(rSession.history) ? rSession.history : []),
            ...(Array.isArray(lSession.history) ? lSession.history : [])
          ]);
          rSession.history = mergedHistory.slice(-60);
          if (lTime > rTime) {
            if (lSession.lastUserAt && Date.parse(lSession.lastUserAt) > Date.parse(rSession.lastUserAt || 0)) rSession.lastUserAt = lSession.lastUserAt;
            if (lSession.lastBotAt && Date.parse(lSession.lastBotAt) > Date.parse(rSession.lastBotAt || 0)) rSession.lastBotAt = lSession.lastBotAt;
            if (lSession.updatedAt && Date.parse(lSession.updatedAt) > Date.parse(rSession.updatedAt || 0)) rSession.updatedAt = lSession.updatedAt;
          }
          if (lSession.human !== undefined && (lTime >= rTime || lSession.humanSource === 'admin_command')) {
            rSession.human = lSession.human;
            rSession.humanSource = lSession.humanSource;
            rSession.handoffAt = lSession.handoffAt;
            rSession.handoffReason = lSession.handoffReason;
          }
          if (lSession.supportModeEnabled !== undefined && (lTime >= rTime || rSession.supportModeEnabled === false)) {
            rSession.supportModeEnabled = Boolean(lSession.supportModeEnabled);
          }
          if (lSession.knowledgeBaseId && (!rSession.knowledgeBaseId || lTime >= rTime)) {
            rSession.knowledgeBaseId = lSession.knowledgeBaseId;
          }
          if (lSession.instancePhone && (!rSession.instancePhone || lTime >= rTime)) {
            rSession.instancePhone = lSession.instancePhone;
          }
          if (lSession.contactRole && (!rSession.contactRole || lTime >= rTime)) {
            rSession.contactRole = lSession.contactRole;
          }
          if (lSession.contactNotes && (!rSession.contactNotes || lTime >= rTime)) {
            rSession.contactNotes = lSession.contactNotes;
          }
          if (lSession.clientName && (!rSession.clientName || lTime >= rTime)) {
            rSession.clientName = lSession.clientName;
            rSession.contactName = lSession.contactName || lSession.clientName;
          }
          if (lSession.pendingPixRequest !== undefined && lTime >= rTime) {
            rSession.pendingPixRequest = lSession.pendingPixRequest && typeof lSession.pendingPixRequest === 'object'
              ? { ...lSession.pendingPixRequest }
              : null;
          }
          const localCopilotTask = normalizePendingCopilotTask(lSession.pendingCopilotTask);
          if (localCopilotTask && Date.parse(localCopilotTask.updatedAt) >= rTime) {
            rSession.pendingCopilotTask = localCopilotTask;
          }
          if (lSession.pendingClientPayment && lTime >= rTime) {
            rSession.pendingClientPayment = normalizePendingClientPayment(lSession.pendingClientPayment);
          }
          if (lSession.pendingOutboundDispatch && (lTime >= rTime || ['sending', 'uncertain'].includes(lSession.pendingOutboundDispatch.status))) {
            rSession.pendingOutboundDispatch = { ...lSession.pendingOutboundDispatch };
          }
          if (lSession.lastAnalyzedDocument && (!rSession.lastAnalyzedDocument || lTime >= rTime)) {
            rSession.lastAnalyzedDocument = lSession.lastAnalyzedDocument;
          }
          rSession.pendingAudioConfirmation = lSession.pendingAudioConfirmation || null;
          rSession.pendingRecipient = lSession.pendingRecipient || null;
          rSession.pendingAsAudio = Boolean(lSession.pendingAsAudio);
          if (lSession.audioPreference) rSession.audioPreference = lSession.audioPreference;
          if (lSession.askedAudioPreference) rSession.askedAudioPreference = lSession.askedAudioPreference;
        }
        nextSessions[key] = rSession;
      }
      const recentCutoffMs = this.now() - 5 * 60_000;
      for (const [key, lSession] of Object.entries(local)) {
        if (!nextSessions[key] && (this.dirty || latestSessionActivityMs(lSession) >= recentCutoffMs)) {
          nextSessions[key] = lSession;
        }
      }
      this.sessions = nextSessions;
      const hasLocalOnly = Object.keys(local).some(key => !remote[key]);
      this.persistence = 'supabase';
      this.remoteError = null;
      if (hasLocalOnly && !isRefresh && !this.initialSyncDone) {
        this.initialSyncDone = true;
        await this.flush();
      }
    } catch (error) {
      this.remoteError = error.message;
      this.logger.warn?.(`[supabase] leitura indisponível; usando arquivos locais: ${error.message}`);
    }
    this.purge();
    return this.sessions;
  }

  async refresh({ force = false, requireRemote = false } = {}) {
    if (!this.client?.enabled) return this.sessions;
    if (this.refreshing) {
      const result = await this.refreshing;
      if (requireRemote && this.remoteError) throw new Error(this.remoteError);
      return result;
    }
    if (!force && this.lastRefreshAt && this.now() - this.lastRefreshAt < 1500 && Object.keys(this.sessions || {}).length > 0) {
      if (requireRemote && this.remoteError) throw new Error(this.remoteError);
      return this.sessions;
    }
    this.refreshing = this.load({ isRefresh: true }).then(result => {
      if (requireRemote && this.remoteError) throw new Error(this.remoteError);
      return result;
    }).finally(() => {
      this.lastRefreshAt = this.now();
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async syncSession(phone, origin = 'real') {
    const norm = normalizePhone(phone);
    const isSim = origin === 'simulation' || norm.startsWith('sim:');
    const cleanPhone = norm.replace(/^sim:/, '');
    const key = isSim ? `sim:${cleanPhone}` : cleanPhone;
    const existed = Boolean(this.sessions[key]);
    const s = this.get(phone, origin);
    if (!this.client?.enabled) return s;

    // Preserva estado local em memória quando há gravação pendente ou em andamento
    if (existed && (this.saveTimer || this.saving)) return s;

    try {
      const rows = await this.client.select('conversations', `select=*,contacts(display_name,push_name,phone)&external_key=eq.${encodeURIComponent(key)}&limit=1`);
      const row = rows?.[0];
      if (!row) return s;

      const remoteTime = new Date(row.updated_at || 0).getTime() || 0;
      const localTime = existed
        ? Math.max(
            new Date(s.updatedAt || 0).getTime() || 0,
            new Date(s.lastUserAt || 0).getTime() || 0,
            new Date(s.lastBotAt || 0).getTime() || 0,
            new Date(s.handoffAt || 0).getTime() || 0,
            new Date(s.takeoverAt || 0).getTime() || 0
          )
        : 0;

      // Só substitui a sessão local se ela ainda não existia em memória ou se o remoto for estritamente mais recente
      if (!existed || remoteTime > localTime) {
        const messages = await this.client.select(
          'conversation_messages',
          `select=conversation_id,external_id,role,content,message_type,from_me,delivery_status,created_at,metadata&conversation_id=eq.${row.id}&order=created_at.desc&limit=60`
        ).catch(() => []);
        const cleanMessages = Array.isArray(messages) ? [...messages].reverse() : [];
        const remoteSession = rowToSession(row, cleanMessages);
        remoteSession._conversationId = row.id || null;
        remoteSession._contactId = row.contact_id || row.contacts?.id || null;
        this.remoteFlushState.set(key, remoteFlushStateForSession(key, row, remoteSession, cleanMessages));

        // Preserva flags voláteis locais se houver
        const localPixRequestedAt = Date.parse(s.pendingPixRequest?.requestedAt || '') || 0;
        if (s.pendingPixRequest && localPixRequestedAt > remoteTime) {
          remoteSession.pendingPixRequest = { ...s.pendingPixRequest };
        }
        const localCopilotTask = normalizePendingCopilotTask(s.pendingCopilotTask);
        if (localCopilotTask && Date.parse(localCopilotTask.updatedAt) > remoteTime) {
          remoteSession.pendingCopilotTask = localCopilotTask;
        }
        const localPayment = normalizePendingClientPayment(s.pendingClientPayment);
        if (localPayment && Date.parse(localPayment.createdAt) > remoteTime) {
          remoteSession.pendingClientPayment = localPayment;
        }
        const localOutbound = s.pendingOutboundDispatch;
        const localOutboundAt = Date.parse(localOutbound?.createdAt || '') || 0;
        if (localOutbound && (['sending', 'uncertain'].includes(localOutbound.status) || localOutboundAt > remoteTime)) {
          remoteSession.pendingOutboundDispatch = { ...localOutbound };
        }
        remoteSession.pendingAudioConfirmation = s.pendingAudioConfirmation || null;
        remoteSession.pendingRecipient = s.pendingRecipient || null;
        remoteSession.pendingAsAudio = Boolean(s.pendingAsAudio);

        this.sessions[key] = remoteSession;
        return remoteSession;
      }
    } catch (err) {
      this.logger.warn?.(`[supabase] falha ao sincronizar sessão pontual de ${maskKey(key)}: ${err.message}`);
    }
    return s;
  }

  async claimFollowUp(externalKey, claimedAt, leaseSeconds = 900) {
    if (!this.client?.enabled) throw new Error('Supabase necessário para claim distribuída');
    const token = await this.client.rpc('claim_follow_up', {
      p_external_key: externalKey,
      p_claimed_at: new Date(claimedAt).toISOString(),
      p_lease_seconds: leaseSeconds
    });
    if (token === null || token === undefined || token === false || (typeof token === 'string' && !token.trim())) return null;
    if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      throw new Error('Resposta inválida ao reservar follow-up no Supabase');
    }
    return token;
  }

  async claimOutboundDispatch(dispatchId) {
    if (!this.client?.enabled || typeof this.client.request !== 'function') return false;
    const key = String(dispatchId || '').trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(key)) return false;
    const inserted = await this.client.request('idempotency_keys', {
      method: 'POST',
      query: 'on_conflict=scope,key',
      body: {
        scope: 'outbound_dispatch',
        key,
        resource_id: null,
        status_code: 202,
        response_body: { status: 'sending' }
      },
      prefer: 'resolution=ignore-duplicates,return=representation'
    });
    return Array.isArray(inserted) && inserted.length > 0;
  }

  async completeFollowUp(externalKey, claimToken, sentAt) {
    if (!this.client?.enabled || !claimToken) return false;
    const completed = await this.client.rpc('complete_follow_up', {
      p_external_key: externalKey,
      p_claim_token: claimToken,
      p_sent_at: new Date(sentAt).toISOString()
    });
    return completed === true;
  }

  async releaseFollowUpClaim(externalKey, claimToken) {
    if (!this.client?.enabled || !claimToken) return false;
    const released = await this.client.rpc('release_follow_up_claim', {
      p_external_key: externalKey,
      p_claim_token: claimToken
    });
    return released === true;
  }

  async flush() {
    // O snapshot local é SEMPRE gravado: ele é o fallback real quando o Supabase
    // está indisponível, não um arquivo que fica congelado desde o boot.
    const local = super.flush();
    if (!this.client?.enabled) return local;
    this.dirty = false;
    this._remoteFlushDirty = true;
    if (!this._remoteFlushPromise) {
      this._remoteFlushPromise = (async () => {
        try {
          while (this._remoteFlushDirty) {
            this._remoteFlushDirty = false;
            await this._flushRemoteOnce();
          }
        } finally {
          this._remoteFlushPromise = null;
        }
      })();
    }
    await Promise.all([local, this._remoteFlushPromise]);
  }

  async _flushRemoteOnce() {
    try {
      for (const [key, session] of Object.entries(this.sessions)) {
        const isSimulation = key.startsWith('sim:');
        let state = this.remoteFlushState.get(key);
        if (!state) {
          state = {
            conversationId: session._conversationId || null,
            contactId: session._contactId || null,
            lastSeenAt: null,
            contactSignature: null,
            conversationSignature: null,
            messages: new Map()
          };
          this.remoteFlushState.set(key, state);
        }

        // Contatos só são escritos quando identidade, nome ou last_seen_at muda.
        let contactId = session._contactId || state.contactId || null;
        if (!isSimulation) {
          const contactPayload = contactRowForSession(key, session, state.lastSeenAt);
          const contactSignature = JSON.stringify(contactPayload);
          if (!contactId || state.contactSignature !== contactSignature) {
            const contacts = await this.client.upsert(
              'contacts',
              [contactPayload],
              'channel,external_id',
              { returnRepresentation: !contactId }
            );
            contactId = contacts?.[0]?.id || contactId;
            state.contactId = contactId;
            state.contactSignature = contactSignature;
            state.lastSeenAt = contactPayload.last_seen_at;
            session._contactId = contactId;
          }
        }

        // Conversas são atualizadas somente quando o payload persistido mudou.
        const conversationPayload = sessionToConversation(key, session, contactId);
        const conversationSignature = JSON.stringify(conversationPayload);
        let conversationId = session._conversationId || state.conversationId || null;
        if (!conversationId || state.conversationSignature !== conversationSignature) {
          const conversations = await this.client.upsert(
            'conversations',
            [conversationPayload],
            'external_key',
            { returnRepresentation: !conversationId }
          );
          conversationId = conversations?.[0]?.id || conversationId;
          if (!conversationId) continue;
          state.conversationId = conversationId;
          state.conversationSignature = conversationSignature;
          session._conversationId = conversationId;
        }

        session.history = dedupeMessages(session.history || []);
        const pendingMessages = [];
        const pendingSignatures = new Map();
        const seenExtIds = new Set();
        for (let index = 0; index < session.history.length; index += 1) {
          const message = session.history[index];
          const row = messageRowForSession(key, conversationId, index, message);
          if (seenExtIds.has(row.external_id)) continue;
          seenExtIds.add(row.external_id);
          const signature = JSON.stringify(row);
          if (state.messages.get(row.external_id) === signature) continue;
          pendingMessages.push(row);
          pendingSignatures.set(row.external_id, signature);
        }

        // Só envia mensagens novas/alteradas, nunca todo o histórico a cada flush.
        if (pendingMessages.length) {
          await this.client.upsert(
            'conversation_messages',
            pendingMessages,
            'conversation_id,external_id',
            { returnRepresentation: false }
          );
          for (const [externalId, signature] of pendingSignatures) {
            state.messages.set(externalId, signature);
          }
        }
      }
      this.persistence = 'supabase';
      this.remoteError = null;
    } catch (error) {
      this.persistence = 'fallback';
      this.remoteError = error.message;
      this.logger.warn?.(`[supabase] gravação remota indisponível; snapshot local atualizado (fallback ativo): ${error.message}`);
    }
  }
  async resolveConversationKey(key) {
    const raw = String(key || '').trim();
    if (!raw) return '';
    if (/@lid$/i.test(raw)) {
      if (this.lidMap?.has(raw)) return this.lidMap.get(raw);
      for (const [k, s] of Object.entries(this.sessions || {})) {
        if (s?.jid === raw || s?.lid === raw) return k;
      }
      if (this.client?.enabled) {
        try {
          const rows = await this.client.select('conversations', `select=external_key&metadata->>jid=eq.${encodeURIComponent(raw)}&deleted_at=is.null&limit=1`);
          if (rows?.[0]?.external_key) return rows[0].external_key;
        } catch {}
      }
    }
    return normalizePhone(raw);
  }

  async archive(phone, reason = '') {
    const key = await this.resolveConversationKey(phone);
    const result = await super.archive(key, reason);
    if (this.client?.enabled && result) {
      try {
        const isSimulation = key.startsWith('sim:');
        const externalId = key.replace(/^sim:/, '');
        const resolvedName = result.clientName || result.contactName || result.pushName || null;
        let contactId = null;
        if (!isSimulation) {
          const contacts = await this.client.upsert('contacts', [{
            channel: 'whatsapp',
            external_id: externalId,
            phone: /^\d{8,15}$/.test(externalId) ? externalId : null,
            display_name: resolvedName,
            push_name: result.pushName || resolvedName
          }], 'channel,external_id');
          contactId = contacts?.[0]?.id;
        }
        const archived = { ...result, archivedAt: new Date().toISOString(), archiveReason: reason };
        await this.client.upsert('conversations', [sessionToConversation(key, archived, contactId)], 'external_key');
      } catch (error) { this.remoteError = error.message; this.logger.warn?.(`[supabase] arquivamento remoto indisponível; cópia local preservada: ${error.message}`); }
    }
    return result;
  }

  async softDeleteConversation({ key, source = 'dashboard', archive = true } = {}) {
    const cleanKey = await this.resolveConversationKey(key);
    if (!cleanKey) return false;
    delete this.sessions?.[cleanKey];
    this.markDirty?.();
    await this.flush?.().catch(() => {});

    if (!this.client?.enabled) return true;
    const now = new Date().toISOString();
    try {
      const convs = await this.client.select('conversations', `select=id&external_key=eq.${encodeURIComponent(cleanKey)}&limit=1`);
      const convId = convs?.[0]?.id;
      if (archive) {
        await this.client.request('conversations', {
          method: 'PATCH',
          query: `external_key=eq.${encodeURIComponent(cleanKey)}`,
          body: { deleted_at: now, deleted_source: source, updated_at: now }
        });
        if (convId) {
          await this.client.request('conversation_messages', {
            method: 'PATCH',
            query: `conversation_id=eq.${encodeURIComponent(convId)}&deleted_at=is.null`,
            body: { deleted_at: now, deleted_source: source }
          });
        }
      } else {
        await this.client.request('conversations', {
          method: 'DELETE',
          query: `external_key=eq.${encodeURIComponent(cleanKey)}`
        });
      }
      return true;
    } catch (error) {
      this.remoteError = error.message;
      this.logger.warn?.(`[supabase] softDeleteConversation falhou: ${error.message}`);
      return false;
    }
  }

  async softDeleteMessage({ externalId, source = 'whatsapp', archive = true } = {}) {
    if (!externalId) return false;
    const candidates = [String(externalId), `wa:${externalId}`];
    for (const s of Object.values(this.sessions || {})) {
      if (Array.isArray(s.history)) {
        s.history = s.history.filter(m => !candidates.includes(String(m.id || '')));
      }
    }
    this.markDirty?.();
    if (!this.client?.enabled) return true;
    const now = new Date().toISOString();
    const inList = candidates.map(c => `"${c.replace(/"/g, '')}"`).join(',');
    try {
      if (archive) {
        await this.client.request('conversation_messages', {
          method: 'PATCH',
          query: `external_id=in.(${inList})`,
          body: { deleted_at: now, deleted_source: source }
        });
      } else {
        await this.client.request('conversation_messages', {
          method: 'DELETE',
          query: `external_id=in.(${inList})`
        });
      }
      return true;
    } catch (error) {
      this.remoteError = error.message;
      this.logger.warn?.(`[supabase] softDeleteMessage falhou: ${error.message}`);
      return false;
    }
  }

  async recordAICall(call) {
    if (!this.client?.enabled) return;
    try { await this.client.insert('ai_calls', [{ request_id: call.requestId || null, provider: call.provider || 'desconhecido', model: call.model || null, latency_ms: call.latencyMs || 0, prompt_tokens: call.promptTokens || 0, completion_tokens: call.completionTokens || 0, total_tokens: call.totalTokens || 0, intent: call.intent || null, success: call.success !== false, error_message: call.error || null }]); } catch (error) { this.logger.warn?.(`[supabase] ai_calls indisponível: ${error.message}`); }
  }
}

export class SupabaseAdminConfigStore extends AdminConfigStore {
  constructor(file, { client, logger = console, ...options } = {}) { super(file, { logger, ...options }); this.client = client; this.logger = logger; this.persistence = 'fallback'; this.remoteError = null; this.remoteLoadComplete = false; }

  async load() {
    this.remoteLoadComplete = false;
    await super.load();
    if (!this.client?.enabled) return this;
    try {
      const state = (await this.client.select('bot_config_state', 'select=*&id=eq.true&limit=1'))?.[0];
      if (state?.active_config && Object.keys(state.active_config).length) {
        this.active = normalizeBotConfig(state.active_config);
        this.draft = normalizeBotConfig(merge(this.active, state.draft_config || {}));
        this.revision = Number(state.revision || 0);
        this.updatedAt = state.updated_at || null;
        const revisions = await this.client.select('bot_config_revisions', 'select=revision,action,source_revision,snapshot,created_at&order=created_at.desc&limit=30');
        this.history = revisions.reverse().map(item => ({ revision: item.revision, action: item.action, sourceRevision: item.source_revision, at: item.created_at, ...(item.snapshot ? { snapshot: item.snapshot } : {}) }));
      }
      this.remoteLoadComplete = true;
      if (state?.active_config && Object.keys(state.active_config).length) {
        this.persistence = 'supabase';
        this.remoteError = null;
      } else {
        await this.flush();
        if (this.persistence !== 'supabase') throw new Error(this.remoteError || 'Supabase não confirmou a inicialização da configuração.');
      }
    } catch (error) { this.remoteError = error.message; this.logger.warn?.(`[supabase] configuração indisponível; usando arquivo local: ${error.message}`); }
    return this;
  }

  // Concorrência entre réplicas: quando o Supabase é a fonte ativa, `baseRevision`
  // também é comparado com a revisão remota atual, para que um dashboard conectado
  // a outra réplica não sobrescreva silenciosamente mudanças recentes. Em falha de
  // leitura, cai para a comparação local (comportamento anterior).
  async _staleBaseRevision(baseRevision) {
    if (baseRevision === undefined || baseRevision === null || baseRevision === '') return null;
    let remoteRevision = null;
    if (this.client?.enabled && this.persistence === 'supabase') {
      try {
        const state = (await this.client.select('bot_config_state', 'select=revision&id=eq.true&limit=1'))?.[0];
        if (state && state.revision !== null && state.revision !== undefined) remoteRevision = Number(state.revision);
      } catch (error) {
        this.logger?.warn?.(`[supabase] revisão remota indisponível para baseRevision; usando local: ${error.message}`);
      }
    }
    // O remoto, quando legível, é autoritativo: a revisão local pode estar
    // atrasada em relação a outra réplica. Sem leitura remota, comparação local.
    const authoritative = Number.isFinite(remoteRevision) ? remoteRevision : Number(this.revision);
    if (Number(baseRevision) === authoritative) return null;
    return ['config_alterada_por_outro_usuário: a configuração mudou no servidor. Recarregue e tente novamente.'];
  }

  async flush() {
    const local = super.flush();
    if (!this.client?.enabled) return local;
    if (!this.remoteLoadComplete) {
      await local;
      this.persistence = 'fallback';
      this.remoteError = this.remoteError || 'Leitura inicial do estado Supabase não foi confirmada.';
      return;
    }
    const snapshot = { revision: this.revision, active: this.active, draft: this.draft, history: this.history.slice(), updatedAt: this.updatedAt };    const remote = (async () => {
      try {
        await this.client.upsert('bot_config_state', [{ id: true, revision: snapshot.revision, active_config: snapshot.active, draft_config: snapshot.draft, updated_at: snapshot.updatedAt || null }], 'id');
        const rawRows = snapshot.history.filter(item => item.snapshot).map(item => ({ revision: item.revision, action: item.action === 'draft_updated' ? 'draft_updated' : item.action === 'rollback' ? 'rollback' : 'published', source_revision: item.sourceRevision || null, snapshot: item.snapshot }));
        const deduped = new Map();
        for (const r of rawRows) deduped.set(`${r.revision}:${r.action}`, r);
        const rows = [...deduped.values()];
        if (rows.length) await this.client.upsert('bot_config_revisions', rows, 'revision,action');
        this.persistence = 'supabase'; this.remoteError = null;
      } catch (error) { this.persistence = 'fallback'; this.remoteError = error.message; this.logger.warn?.(`[supabase] configuração não gravada; fallback local preservado: ${error.message}`); }
    })();
    // Serializa o flush remoto na mesma ordem do local: upserts Supabase nunca correm fora de ordem.
    this.remoteSaving = (this.remoteSaving || Promise.resolve()).catch(() => {}).then(() => remote);
    await Promise.all([local, this.remoteSaving]);
  }
}

export function createSupabaseRuntime({ url, serviceRoleKey, logger = console } = {}) {
  const client = new SupabaseRestClient({ url, key: serviceRoleKey, logger });
  return { client, enabled: client.enabled };
}
