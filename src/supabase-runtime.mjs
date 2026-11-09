import crypto from 'node:crypto';
import { SessionStore, normalizePhone } from './sessions.mjs';
import { AdminConfigStore, DEFAULT_BOT_CONFIG, merge } from './admin-config.mjs';

const jsonClone = value => JSON.parse(JSON.stringify(value));
const iso = value => value ? new Date(value).toISOString() : null;

export class SupabaseRestClient {
  constructor({ url, key, logger = console } = {}) {
    this.url = String(url || '').replace(/\/$/, '');
    this.key = key || '';
    this.logger = logger;
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
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(`Supabase ${method} ${table} HTTP ${response.status}: ${data?.message || data?.hint || text || 'erro desconhecido'}`);
    return data;
  }

  async select(table, query) { return this.request(table, { query }); }
  async upsert(table, rows, onConflict) { return this.request(table, { method: 'POST', query: onConflict ? `on_conflict=${encodeURIComponent(onConflict)}` : '', body: rows, prefer: 'resolution=merge-duplicates,return=representation' }); }
  async insert(table, rows) { return this.request(table, { method: 'POST', body: rows, prefer: 'return=minimal' }); }
}

const externalIdFor = (key, index, message) => {
  if (message.id) {
    const id = String(message.id);
    return id.startsWith('runtime:') || id.startsWith('wa:') ? id : `wa:${id}`;
  }
  const datePart = message.createdAt ? String(message.createdAt).slice(0, 10) : 'nodate';
  const hash = crypto.createHash('sha1').update(`${message.role}:${datePart}:${String(message.content || '').trim()}`).digest('hex').slice(0, 16);
  return `runtime:${key}:${index}:${hash}`;
};

function dedupeMessages(messages = []) {
  const out = [];
  const seenIds = new Set();
  for (const m of messages) {
    if (!m || !m.content) continue;
    if (m.id && seenIds.has(String(m.id))) continue;
    if (m.id) seenIds.add(String(m.id));
    out.push(m);
  }
  return out;
}

function rowToSession(row, messages = []) {
  const c = row.contacts || {};
  const meta = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};
  const key = row.external_key;
  const resolvedName = row.contact_name || c.display_name || c.push_name || '';
  const cleanMessages = dedupeMessages(
    messages.map(m => ({ role: m.role, content: m.content, createdAt: m.created_at || null, ...(m.external_id ? { id: m.external_id } : {}) }))
  );
  return {
    phone: c.phone || key.replace(/^sim:/, ''),
    origin: row.origin,
    history: cleanMessages,
    human: row.mode === 'human',
    humanSource: row.human_source || null,
    updatedAt: iso(row.updated_at),
    clientName: resolvedName,
    contactName: resolvedName,
    pushName: c.push_name || '',
    supportModeEnabled: Boolean(meta.supportModeEnabled),
    knowledgeBaseId: meta.knowledgeBaseId || null,
    contactRole: meta.contactRole || null,
    contactNotes: meta.contactNotes || '',
    audioPreference: meta.audioPreference || undefined,
    askedAudioPreference: Boolean(meta.askedAudioPreference),
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
    archivedAt: iso(row.archived_at),
    status: row.status,
    archiveReason: row.archive_reason || undefined,
    legalHold: Boolean(meta.legalHold || meta.legal_hold),
    _conversationId: row.id,
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
    contact_id: contactId,
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
    archived_at: date(session.archivedAt),
    archive_reason: session.archiveReason || null,
    metadata: {
      runtime: 'node',
      role: 'lia-assistant',
      supportModeEnabled: Boolean(session.supportModeEnabled),
      knowledgeBaseId: session.knowledgeBaseId || null,
      contactRole: session.contactRole || null,
      contactNotes: session.contactNotes || '',
      audioPreference: session.audioPreference || null,
      askedAudioPreference: Boolean(session.askedAudioPreference),
      legalHold: Boolean(session.legalHold || session.metadata?.legalHold),
      legal_hold: Boolean(session.legal_hold || session.metadata?.legal_hold)
    }
  };
}

export class SupabaseSessionStore extends SessionStore {
  constructor(file, { client, logger = console, ...options } = {}) {
    super(file, { logger, ...options });
    this.client = client;
    this.logger = logger;
    this.persistence = 'fallback';
    this.remoteError = null;
    this.refreshing = null;
    this.lastRetentionSweepAt = 0;
  }

  async purgeArchives() {
    const localRemoved = await super.purgeArchives();
    if (!this.client?.enabled || this.now() - this.lastRetentionSweepAt < 6 * 3600000) return localRemoved;
    this.lastRetentionSweepAt = this.now();
    const cutoff = new Date(this.now() - this.ttlMs).toISOString();
    try {
      const rows = await this.client.select('conversations', `select=id,status,archived_at,metadata&status=eq.archived&archived_at=lt.${encodeURIComponent(cutoff)}&limit=500`);
      for (const row of rows || []) {
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
      this.remoteError = null;
    } catch (error) {
      this.remoteError = error.message;
      this.logger.warn?.(`[supabase] retenção remota preservada por falha de limpeza: ${error.message}`);
    }
    return localRemoved;
  }

  async load() {
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
    if (!this.client?.enabled) return this.sessions;
    try {
      const rows = await this.client.select('conversations', 'select=*,contacts(display_name,push_name,phone)&status=neq.closed&order=updated_at.desc&limit=500');
      const ids = rows.map(row => row.id).filter(Boolean);
      const messageBatches = await Promise.all(
        ids.map(id =>
          this.client.select(
            'conversation_messages',
            `select=conversation_id,external_id,role,content,created_at&conversation_id=eq.${id}&order=created_at.desc&limit=60`
          ).catch(err => {
            this.logger.warn?.(`[supabase] falha ao buscar mensagens de ${id}: ${err.message}`);
            return [];
          })
        )
      );
      const grouped = new Map();
      for (const batch of messageBatches) {
        if (!Array.isArray(batch)) continue;
        for (const message of [...batch].reverse()) {
          if (!grouped.has(message.conversation_id)) grouped.set(message.conversation_id, []);
          grouped.get(message.conversation_id).push(message);
        }
      }
      const remote = {};
      for (const row of rows) {
        const key = row.external_key;
        remote[key] = rowToSession(row, grouped.get(row.id) || []);
      }
      const local = { ...(this.sessions || {}) };
      for (const [key, rSession] of Object.entries(remote)) {
        const lSession = local[key];
        if (lSession) {
          lSession.history = dedupeMessages(lSession.history || []);
          const lTime = new Date(lSession.lastUserAt || lSession.lastBotAt || lSession.updatedAt || 0).getTime();
          const rTime = new Date(rSession.lastUserAt || rSession.lastBotAt || rSession.updatedAt || 0).getTime();
          if (Array.isArray(lSession.history) && lSession.history.length > 0 && lTime >= rTime) {
            rSession.history = lSession.history;
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
          rSession.pendingAudioConfirmation = lSession.pendingAudioConfirmation || null;
          rSession.pendingRecipient = lSession.pendingRecipient || null;
          rSession.pendingAsAudio = Boolean(lSession.pendingAsAudio);
          if (lSession.audioPreference) rSession.audioPreference = lSession.audioPreference;
          if (lSession.askedAudioPreference) rSession.askedAudioPreference = lSession.askedAudioPreference;
        }
        this.sessions[key] = rSession;
      }
      for (const [key, lSession] of Object.entries(local)) {
        if (!this.sessions[key]) this.sessions[key] = lSession;
      }
      const hasLocalOnly = Object.keys(local).some(key => !remote[key]);
      this.persistence = 'supabase';
      this.remoteError = null;
      if (hasLocalOnly) await this.flush();
    } catch (error) {
      this.remoteError = error.message;
      this.logger.warn?.(`[supabase] leitura indisponível; usando arquivos locais: ${error.message}`);
    }
    this.purge();
    return this.sessions;
  }

  async refresh() {
    if (!this.client?.enabled || this.refreshing) return this.refreshing;
    this.refreshing = this.load().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async flush() {
    const local = super.flush();
    if (!this.client?.enabled) return local;
    const remote = (async () => {
      try {
        for (const [key, session] of Object.entries(this.sessions)) {
          const externalId = key.replace(/^sim:/, '');
          const resolvedName = session.clientName || session.contactName || session.pushName || null;
          const contacts = await this.client.upsert('contacts', [{
            channel: 'whatsapp',
            external_id: externalId,
            phone: /^\d{8,15}$/.test(externalId) ? externalId : null,
            display_name: resolvedName,
            push_name: session.pushName || resolvedName,
            last_seen_at: session.lastUserAt || new Date().toISOString()
          }], 'channel,external_id');
          const contactId = contacts?.[0]?.id;
          const conversations = await this.client.upsert('conversations', [sessionToConversation(key, session, contactId)], 'external_key');
          const conversationId = conversations?.[0]?.id || session._conversationId;
          if (!conversationId) continue;
          session._conversationId = conversationId;
          session.history = dedupeMessages(session.history || []);
          const messages = [];
          const seenExtIds = new Set();
          for (let index = 0; index < session.history.length; index++) {
            const message = session.history[index];
            if (!message.createdAt) {
              message.createdAt = session.lastBotAt || session.lastUserAt || session.updatedAt || new Date().toISOString();
            }
            const extId = externalIdFor(key, index, message);
            if (seenExtIds.has(extId)) continue;
            seenExtIds.add(extId);
            messages.push({
              conversation_id: conversationId,
              external_id: extId,
              role: message.role === 'assistant' ? 'assistant' : 'user',
              content: String(message.content || ''),
              message_type: 'text',
              from_me: message.role === 'assistant',
              delivery_status: message.role === 'assistant' ? 'sent' : 'received',
              created_at: message.createdAt,
              metadata: { runtime: 'node' }
            });
          }
          if (messages.length) await this.client.upsert('conversation_messages', messages, 'conversation_id,external_id');
        }
        this.persistence = 'supabase';
        this.remoteError = null;
      } catch (error) {
        this.persistence = 'fallback';
        this.remoteError = error.message;
        this.logger.warn?.(`[supabase] gravação indisponível; fallback local preservado: ${error.message}`);
      }
    })();
    await Promise.all([local, remote]);
  }

  async archive(phone, reason = '') {
    const key = normalizePhone(phone);
    const result = await super.archive(phone, reason);
    if (this.client?.enabled && result) {
      try {
        const externalId = key.replace(/^sim:/, '');
        const resolvedName = result.clientName || result.contactName || result.pushName || null;
        const contacts = await this.client.upsert('contacts', [{
          channel: 'whatsapp',
          external_id: externalId,
          phone: /^\d{8,15}$/.test(externalId) ? externalId : null,
          display_name: resolvedName,
          push_name: result.pushName || resolvedName
        }], 'channel,external_id');
        const archived = { ...result, archivedAt: new Date().toISOString(), archiveReason: reason };
        await this.client.upsert('conversations', [sessionToConversation(key, archived, contacts?.[0]?.id)], 'external_key');
      } catch (error) { this.remoteError = error.message; this.logger.warn?.(`[supabase] arquivamento remoto indisponível; cópia local preservada: ${error.message}`); }
    }
    return result;
  }

  async recordAICall(call) {
    if (!this.client?.enabled) return;
    try { await this.client.insert('ai_calls', [{ provider: call.provider || 'desconhecido', model: call.model || null, latency_ms: call.latencyMs || 0, prompt_tokens: call.promptTokens || 0, completion_tokens: call.completionTokens || 0, total_tokens: call.totalTokens || 0, intent: call.intent || null, success: call.success !== false, error_message: call.error || null }]); } catch (error) { this.logger.warn?.(`[supabase] ai_calls indisponível: ${error.message}`); }
  }
}

export class SupabaseAdminConfigStore extends AdminConfigStore {
  constructor(file, { client, logger = console, ...options } = {}) { super(file, { logger, ...options }); this.client = client; this.logger = logger; this.persistence = 'fallback'; this.remoteError = null; }

  async load() {
    await super.load();
    if (!this.client?.enabled) return this;
    try {
      const state = (await this.client.select('bot_config_state', 'select=*&id=eq.true&limit=1'))?.[0];
      if (state?.active_config && Object.keys(state.active_config).length) {
        this.active = merge(DEFAULT_BOT_CONFIG, state.active_config);
        this.draft = merge(this.active, state.draft_config || {});
        this.revision = Number(state.revision || 0);
        this.updatedAt = state.updated_at || null;
        const revisions = await this.client.select('bot_config_revisions', 'select=revision,action,source_revision,snapshot,created_at&order=created_at.desc&limit=30');
        this.history = revisions.reverse().map(item => ({ revision: item.revision, action: item.action, sourceRevision: item.source_revision, at: item.created_at, ...(item.snapshot ? { snapshot: item.snapshot } : {}) }));
      } else await this.flush();
      this.persistence = 'supabase'; this.remoteError = null;
    } catch (error) { this.remoteError = error.message; this.logger.warn?.(`[supabase] configuração indisponível; usando arquivo local: ${error.message}`); }
    return this;
  }

  async flush() {
    const local = super.flush();
    if (!this.client?.enabled) return local;
    const remote = (async () => {
      try {
        await this.client.upsert('bot_config_state', [{ id: true, revision: this.revision, active_config: this.active, draft_config: this.draft }], 'id');
        const rows = this.history.filter(item => item.snapshot).map(item => ({ revision: item.revision, action: item.action === 'draft_updated' ? 'draft_updated' : item.action === 'rollback' ? 'rollback' : 'published', source_revision: item.sourceRevision || null, snapshot: item.snapshot }));
        if (rows.length) await this.client.upsert('bot_config_revisions', rows, 'revision,action');
        this.persistence = 'supabase'; this.remoteError = null;
      } catch (error) { this.persistence = 'fallback'; this.remoteError = error.message; this.logger.warn?.(`[supabase] configuração não gravada; fallback local preservado: ${error.message}`); }
    })();
    await Promise.all([local, remote]);
  }
}

export function createSupabaseRuntime({ url, serviceRoleKey, logger = console } = {}) {
  const client = new SupabaseRestClient({ url, key: serviceRoleKey, logger });
  return { client, enabled: client.enabled };
}
