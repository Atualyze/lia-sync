import crypto from 'node:crypto';

export const RUNTIME_EVENT_TYPES = Object.freeze([
  'message.received',
  'task.created',
  'task.completed',
  'task.failed',
  'task.uncertain',
  'task.expired',
  'followup.due',
  'goal.created',
  'goal.updated',
  'goal.deadline',
  'lead.created',
  'lead.updated',
  'calendar.event_due',
  'commitment.due',
  'system.error',
  'system.health_change'
]);

const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
const SENSITIVE_KEY_RE = /(?:token|secret|password|apikey|api_key|authorization|cookie|private_key|service_role)/i;
const MAX_CAUSATION_DEPTH = 3;

export function sanitizeEventPayload(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.slice(0, 1000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeEventPayload(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 40)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      out[key] = sanitizeEventPayload(val, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 200);
}

export function buildEventDeduplicationKey({ type, source = 'system', subject = '', deduplicationKey = '', occurredAt = '' } = {}) {
  const explicit = String(deduplicationKey || '').trim();
  if (explicit) return explicit.slice(0, 200);
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ type: String(type || ''), source: String(source || ''), subject: String(subject || ''), occurredAt: String(occurredAt || '') }))
    .digest('hex');
  return `evt:${digest}`;
}

export class EventEngine {
  constructor({ store, now = () => Date.now(), logger = console } = {}) {
    this.store = store;
    this.now = now;
    this.logger = logger;
    this.handlers = new Map();
  }

  on(eventType, handler) {
    const key = String(eventType || '*').trim();
    if (typeof handler !== 'function') throw new Error('event_handler_must_be_function');
    if (!this.handlers.has(key)) this.handlers.set(key, []);
    this.handlers.get(key).push(handler);
    return () => {
      const list = this.handlers.get(key) || [];
      this.handlers.set(key, list.filter(fn => fn !== handler));
    };
  }

  async emit({
    type,
    source = 'system',
    subject = '',
    occurredAt = null,
    payload = {},
    priority = 'medium',
    deduplicationKey = '',
    maxAttempts = 3,
    metadata = {}
  } = {}) {
    const cleanType = String(type || '').trim().slice(0, 80);
    if (!cleanType) throw new Error('event_type_required');
    const causationDepth = Number(metadata?.causation_depth || 0);
    if (causationDepth > MAX_CAUSATION_DEPTH) {
      throw new Error('event_causation_depth_exceeded');
    }
    const nowIso = new Date(this.now()).toISOString();
    const occurredIso = occurredAt && Number.isFinite(Date.parse(occurredAt))
      ? new Date(Date.parse(occurredAt)).toISOString()
      : nowIso;
    const dedupeKey = buildEventDeduplicationKey({
      type: cleanType,
      source,
      subject,
      deduplicationKey,
      occurredAt: occurredIso
    });
    const record = {
      id: crypto.randomUUID(),
      type: cleanType,
      source: String(source || 'system').trim().slice(0, 80),
      subject: String(subject || '').trim().slice(0, 160),
      occurred_at: occurredIso,
      payload: sanitizeEventPayload(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}),
      priority: VALID_PRIORITIES.has(priority) ? priority : 'medium',
      deduplication_key: dedupeKey,
      status: 'pending',
      attempts: 0,
      max_attempts: Math.max(1, Math.min(5, Number(maxAttempts) || 3)),
      last_error: null,
      attention: {},
      metadata: sanitizeEventPayload({
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
        causation_depth: causationDepth
      }),
      created_at: nowIso,
      updated_at: nowIso,
      processed_at: null
    };
    return this.store.insertEventIdempotent(record);
  }

  async recoverStaleProcessing(staleMs = 5 * 60 * 1000) {
    const processing = await this.store.listEvents({ statuses: ['processing'], limit: 100 });
    const nowMs = this.now();
    let recovered = 0;
    for (const event of processing) {
      const updatedTs = Date.parse(event.updated_at || event.created_at || '');
      if (!Number.isFinite(updatedTs) || nowMs - updatedTs >= staleMs) {
        const exhausted = Number(event.attempts || 0) >= Number(event.max_attempts || 3);
        await this.store.updateEvent(event.id, {
          status: exhausted ? 'dead_letter' : 'pending',
          last_error: exhausted ? 'stale_processing_attempts_exhausted' : 'recovered_from_restart'
        });
        recovered += 1;
      }
    }
    return recovered;
  }

  async listPending(limit = 25) {
    return this.store.listEvents({ statuses: ['pending'], limit });
  }

  async dispatchOne(event, evaluator = null) {
    if (!event || event.status !== 'pending') return { status: 'skipped', event };
    const nextAttempt = Number(event.attempts || 0) + 1;
    await this.store.updateEvent(event.id, { status: 'processing', attempts: nextAttempt, last_error: null });

    let attention = event.attention || {};
    try {
      if (typeof evaluator === 'function') {
        attention = await evaluator(event);
      }
      const typedHandlers = this.handlers.get(event.type) || [];
      const wildcardHandlers = this.handlers.get('*') || [];
      const allHandlers = [...typedHandlers, ...wildcardHandlers];
      const handlerErrors = [];
      for (const handler of allHandlers) {
        try {
          await handler(event, attention);
        } catch (err) {
          handlerErrors.push(String(err?.code || err?.message || 'handler_error').slice(0, 120));
        }
      }
      if (handlerErrors.length) {
        throw new Error(handlerErrors.join('; '));
      }
      const updated = await this.store.updateEvent(event.id, {
        status: 'processed',
        attention,
        processed_at: new Date(this.now()).toISOString(),
        last_error: null
      });
      return { status: 'processed', event: updated || event, attention };
    } catch (error) {
      const code = String(error?.code || error?.message || 'event_dispatch_failed').slice(0, 160);
      const exhausted = nextAttempt >= Number(event.max_attempts || 3);
      const updated = await this.store.updateEvent(event.id, {
        status: exhausted ? 'dead_letter' : 'pending',
        attention,
        last_error: code
      });
      this.logger.warn?.(`[lia-runtime:events] evento ${event.type} falhou (tentativa ${nextAttempt}/${event.max_attempts}): ${code}`);
      return { status: exhausted ? 'dead_letter' : 'retry_scheduled', event: updated || event, error: code };
    }
  }
}
