import crypto from 'node:crypto';

export const COMMITMENT_STATUSES = Object.freeze(['pending', 'in_progress', 'fulfilled', 'missed', 'cancelled']);
const STATUS_SET = new Set(COMMITMENT_STATUSES);

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
    metadata = {}
  } = {}) {
    const cleanTitle = String(title || '').trim().slice(0, 200);
    if (!cleanTitle) throw new Error('commitment_title_required');
    const dueTs = Date.parse(dueAt || '');
    if (!Number.isFinite(dueTs)) throw new Error('commitment_due_at_required');
    const nowIso = new Date(this.now()).toISOString();
    const record = {
      id: crypto.randomUUID(),
      title: cleanTitle,
      description: String(description || '').trim().slice(0, 1000),
      subject: String(subject || '').trim().slice(0, 160),
      due_at: new Date(dueTs).toISOString(),
      status: 'pending',
      goal_id: goalId ? String(goalId).trim() : null,
      notified_event_id: null,
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {},
      created_at: nowIso,
      updated_at: nowIso,
      fulfilled_at: null
    };
    return this.store.upsertCommitment(record);
  }

  async get(id) {
    return this.store.getCommitment(id);
  }

  async list({ status = null } = {}) {
    const all = await this.store.listCommitments();
    if (!status) return all;
    return all.filter(item => item.status === status);
  }

  async setStatus(id, status, extra = {}) {
    if (!STATUS_SET.has(status)) throw new Error('invalid_commitment_status');
    const current = await this.store.getCommitment(id);
    if (!current) return null;
    const nowIso = new Date(this.now()).toISOString();
    const updated = {
      ...current,
      ...extra,
      status,
      updated_at: nowIso,
      fulfilled_at: status === 'fulfilled' ? (current.fulfilled_at || nowIso) : current.fulfilled_at
    };
    return this.store.upsertCommitment(updated);
  }

  async start(id) {
    return this.setStatus(id, 'in_progress');
  }

  async fulfill(id) {
    return this.setStatus(id, 'fulfilled');
  }

  async miss(id) {
    return this.setStatus(id, 'missed');
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
   * Retorna apenas compromissos pendentes com prazo vencido que ainda não
   * geraram evento `commitment.due`. Compromissos concluídos, cancelados ou
   * perdidos nunca disparam novo trabalho.
   */
  async findDue(nowMs = this.now()) {
    const pending = await this.list({ status: 'pending' });
    return pending.filter(item => {
      if (item.notified_event_id) return false;
      const dueTs = Date.parse(item.due_at || '');
      return Number.isFinite(dueTs) && dueTs <= nowMs;
    });
  }
}
