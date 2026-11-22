import crypto from 'node:crypto';

export const COMMITMENT_STATUSES = Object.freeze([
  'pending', 'in_progress', 'fulfilled', 'failed', 'overdue', 'missed', 'uncertain', 'cancelled'
]);
const STATUS_SET = new Set(COMMITMENT_STATUSES);
const RECIPIENT_TYPES = new Set(['client', 'owner']);
const OWNER_TYPES = new Set(['bot', 'owner']);
const COMMITMENT_CATEGORIES = new Set(['financeiro', 'reclamacao', 'pedido_pessoa', 'emergencia', 'outro']);

export class CommitmentStore {
  constructor({ store, now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
  }

  async create({
    title,
    description = '',
    subject = '',
    dueAt,
    goalId = null,
    conversationId = '',
    recipientType = 'owner',
    recipientPhone = '',
    ownerType = 'owner',
    category = 'outro',
    metadata = {},
    deduplicationKey = ''
  } = {}) {
    const cleanTitle = String(title || '').trim().slice(0, 200);
    if (!cleanTitle) throw new Error('commitment_title_required');
    const dueTs = Date.parse(dueAt || '');
    if (!Number.isFinite(dueTs)) throw new Error('commitment_due_at_required');
    const recipient = String(recipientType || 'owner').trim().toLowerCase();
    const owner = String(ownerType || 'owner').trim().toLowerCase();
    const kind = String(category || 'outro').trim().toLowerCase();
    if (!RECIPIENT_TYPES.has(recipient)) throw new Error('invalid_commitment_recipient');
    if (!OWNER_TYPES.has(owner)) throw new Error('invalid_commitment_owner');
    if (!COMMITMENT_CATEGORIES.has(kind)) throw new Error('invalid_commitment_category');
    if (recipient === 'client' && !String(recipientPhone || '').replace(/\D/g, '')) {
      throw new Error('commitment_client_phone_required');
    }
    const dedupeKey = String(deduplicationKey || '').trim().slice(0, 240);
    if (dedupeKey && typeof this.store.getCommitmentByDeduplicationKey === 'function') {
      const existing = await this.store.getCommitmentByDeduplicationKey(dedupeKey);
      if (existing) return existing;
    }
    const nowIso = new Date(this.now()).toISOString();
    const deterministicId = dedupeKey
      ? 'commit_' + crypto.createHash('sha256').update(dedupeKey).digest('hex').slice(0, 40)
      : null;
    const record = {
      id: deterministicId || crypto.randomUUID(),
      deduplication_key: dedupeKey,
      title: cleanTitle,
      description: String(description || '').trim().slice(0, 1000),
      subject: String(subject || '').trim().slice(0, 160),
      due_at: new Date(dueTs).toISOString(),
      status: 'pending',
      goal_id: goalId ? String(goalId).trim() : null,
      conversation_id: String(conversationId || '').trim().slice(0, 180),
      recipient_type: recipient,
      recipient_phone: String(recipientPhone || '').replace(/\D/g, '').slice(0, 20),
      owner_type: owner,
      category: kind,
      notified_event_id: null,
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {},
      created_at: nowIso,
      updated_at: nowIso,
      fulfilled_at: null,
      overdue_at: null,
      failed_at: null,
      failure_reason: null
    };
    return this.store.upsertCommitment(record);
  }

  async get(id) {
    return this.store.getCommitment(id);
  }

  async list({ status = null } = {}) {
    const all = await this.store.listCommitments();
    if (!status) return all;
    const statuses = Array.isArray(status) ? new Set(status) : new Set([status]);
    return all.filter(item => statuses.has(item.status));
  }

  async setStatus(id, status, extra = {}) {
    if (!STATUS_SET.has(status)) throw new Error('invalid_commitment_status');
    const current = await this.store.getCommitment(id);
    if (!current) return null;
    const allowedTransitions = {
      pending: new Set(['in_progress', 'fulfilled', 'failed', 'overdue', 'missed', 'uncertain', 'cancelled']),
      in_progress: new Set(['fulfilled', 'failed', 'overdue', 'missed', 'uncertain', 'cancelled']),
      overdue: new Set(['in_progress', 'fulfilled', 'failed', 'missed', 'uncertain', 'cancelled']),
      failed: new Set(['in_progress', 'cancelled']),
      missed: new Set(['in_progress', 'cancelled']),
      uncertain: new Set(['in_progress', 'fulfilled', 'failed', 'cancelled']),
      fulfilled: new Set(),
      cancelled: new Set()
    };
    if (current.status === status) return current;
    if (!allowedTransitions[current.status]?.has(status)) throw new Error('invalid_commitment_transition');
    const nowIso = new Date(this.now()).toISOString();
    const updated = {
      ...current,
      ...extra,
      status,
      updated_at: nowIso,
      fulfilled_at: status === 'fulfilled' ? (current.fulfilled_at || nowIso) : current.fulfilled_at,
      overdue_at: status === 'overdue' ? (current.overdue_at || nowIso) : current.overdue_at,
      failed_at: status === 'failed' ? (current.failed_at || nowIso) : current.failed_at
    };
    return this.store.upsertCommitment(updated);
  }

  async start(id) {
    return this.setStatus(id, 'in_progress');
  }

  async fulfill(id) {
    return this.setStatus(id, 'fulfilled');
  }

  async fail(id, reason = 'commitment_failed') {
    return this.setStatus(id, 'failed', { failure_reason: String(reason || 'commitment_failed').slice(0, 500) });
  }

  async markOverdue(id, reason = 'commitment_deadline_elapsed') {
    return this.setStatus(id, 'overdue', { failure_reason: String(reason || 'commitment_deadline_elapsed').slice(0, 500) });
  }

  async miss(id) {
    return this.setStatus(id, 'missed');
  }

  async markUncertain(id, reason = 'commitment_outcome_uncertain') {
    return this.setStatus(id, 'uncertain', { failure_reason: String(reason || 'commitment_outcome_uncertain').slice(0, 500) });
  }

  async cancel(id) {
    return this.setStatus(id, 'cancelled');
  }

  async markDueEventEmitted(id, eventId) {
    const current = await this.store.getCommitment(id);
    if (!current) return null;
    return this.store.upsertCommitment({
      ...current,
      notified_event_id: String(eventId || '').trim() || current.notified_event_id,
      updated_at: new Date(this.now()).toISOString()
    });
  }

  /**
   * Retorna compromissos vencidos ainda não notificados. A notificação é
   * convertida em evento persistente e o registro nunca é descartado por TTL.
   */
  async findDue(nowMs = this.now()) {
    const active = await this.list({ status: ['pending', 'in_progress'] });
    return active.filter(item => {
      if (item.notified_event_id) return false;
      const dueTs = Date.parse(item.due_at || '');
      return Number.isFinite(dueTs) && dueTs <= nowMs;
    });
  }
}
