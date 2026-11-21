import crypto from 'node:crypto';
import { sanitizeLearningData, sanitizeLearningString } from './boundary.mjs';

export const EXPERIENCE_OUTCOMES = Object.freeze([
  'success', 'partial_success', 'failure', 'uncertain', 'abandoned'
]);
export const EXPERIENCE_SIGNIFICANCE = Object.freeze(['low', 'medium', 'high', 'critical']);
export const LEARNING_SCOPES = Object.freeze(['individual', 'relationship', 'business', 'segment', 'global']);

const OUTCOME_SET = new Set(EXPERIENCE_OUTCOMES);
const SIGNIFICANCE_SET = new Set(EXPERIENCE_SIGNIFICANCE);
const SCOPE_SET = new Set(LEARNING_SCOPES);

export const FEEDBACK_WEIGHTS = Object.freeze({
  human_correction: 3.0,
  owner_explicit: 2.5,
  customer_response: 2.0,
  objective_metric: 1.8,
  tool_result: 1.2,
  implicit_inference: 0.6
});

const RELEVANT_EVENT_TYPES = new Set([
  'task.completed',
  'task.failed',
  'task.uncertain',
  'goal.progressed',
  'goal.regressed',
  'goal.deadline',
  'customer.responded',
  'lead.converted',
  'lead.rejected',
  'followup.success',
  'followup.failed',
  'tool.error',
  'system.error'
]);

const DEFAULT_EXPERIENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function isExperienceRelevant(input = {}) {
  if (input.irrelevant === true) return false;
  if (input.outcome === 'failure' || input.outcome === 'uncertain') return true;
  if (input.significance === 'high' || input.significance === 'critical') return true;
  if (Array.isArray(input.feedback) && input.feedback.length > 0) return true;
  if (input.eventType && RELEVANT_EVENT_TYPES.has(String(input.eventType))) return true;
  if (input.significance === 'low' && input.outcome === 'success' && !input.goalId && !input.metrics) return false;
  return Boolean(input.action || input.eventType);
}

export class ExperienceStore {
  constructor({ store, now = () => Date.now(), defaultTtlMs = DEFAULT_EXPERIENCE_TTL_MS } = {}) {
    this.store = store;
    this.now = now;
    this.defaultTtlMs = defaultTtlMs;
  }

  async record(input = {}) {
    if (!isExperienceRelevant(input)) {
      return { recorded: false, reason: 'below_relevance_threshold', experience: null };
    }
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const outcome = OUTCOME_SET.has(input.outcome) ? input.outcome : 'uncertain';
    const significance = SIGNIFICANCE_SET.has(input.significance)
      ? input.significance
      : (outcome === 'uncertain' || outcome === 'failure' ? 'high' : 'medium');
    const scope = SCOPE_SET.has(input.scope) ? input.scope : 'business';
    const dedupeKey = String(input.deduplicationKey || '').trim() || `exp:${crypto.createHash('sha256').update(JSON.stringify({
      source: input.source || 'system',
      action: input.action || input.eventType || '',
      taskId: input.taskId || '',
      subject: input.subject || '',
      occurredAt: input.occurredAt || nowIso
    })).digest('hex')}`;

    const ttlMs = Number(input.ttlMs) > 0 ? Number(input.ttlMs) : this.defaultTtlMs;
    const record = {
      id: crypto.randomUUID(),
      deduplication_key: dedupeKey.slice(0, 200),
      occurred_at: input.occurredAt && Number.isFinite(Date.parse(input.occurredAt))
        ? new Date(Date.parse(input.occurredAt)).toISOString()
        : nowIso,
      actor: sanitizeLearningString(input.actor || 'runtime', 80),
      source: sanitizeLearningString(input.source || 'system', 80),
      scope,
      subject: sanitizeLearningString(input.subject || '', 160),
      context: sanitizeLearningData(input.context && typeof input.context === 'object' ? input.context : {}),
      goal_id: input.goalId || input.goal_id || null,
      task_id: input.taskId || input.task_id || null,
      action: sanitizeLearningString(input.action || input.eventType || '', 160),
      expected_result: sanitizeLearningString(input.expectedResult || input.expected_result || '', 300),
      actual_result: sanitizeLearningString(input.actualResult || input.actual_result || '', 300),
      outcome,
      feedback: Array.isArray(input.feedback) ? sanitizeLearningData(input.feedback) : [],
      error: input.error ? sanitizeLearningString(input.error, 240) : null,
      metrics: sanitizeLearningData(input.metrics && typeof input.metrics === 'object' ? input.metrics : {}),
      significance,
      reflected: false,
      expires_at: new Date(nowMs + ttlMs).toISOString(),
      metadata: sanitizeLearningData(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
      created_at: nowIso,
      updated_at: nowIso
    };

    const { experience, created } = await this.store.insertExperienceIdempotent(record);
    return { recorded: true, created, experience };
  }

  async get(id) {
    return this.store.getFromCollection('experiences', 'lia_experiences', id);
  }

  async list({ outcome = null, reflected = null, scope = null, limit = 200 } = {}) {
    const all = await this.store.listCollection('experiences', 'lia_experiences', limit);
    return all.filter(item => {
      if (outcome && item.outcome !== outcome) return false;
      if (reflected !== null && Boolean(item.reflected) !== Boolean(reflected)) return false;
      if (scope && item.scope !== scope) return false;
      return true;
    });
  }

  async markReflected(id, reflectionSummary = null) {
    const current = await this.get(id);
    if (!current) return null;
    return this.store.upsertInCollection('experiences', 'lia_experiences', {
      ...current,
      reflected: true,
      metadata: {
        ...(current.metadata || {}),
        ...(reflectionSummary ? { reflection: sanitizeLearningData(reflectionSummary) } : {})
      }
    });
  }
}

export class FeedbackEngine {
  constructor({ experienceStore, now = () => Date.now() } = {}) {
    this.experienceStore = experienceStore;
    this.now = now;
  }

  async recordFeedback(experienceId, {
    polarity = 'neutral',
    source = 'implicit_inference',
    reason = '',
    correction = '',
    metrics = {}
  } = {}) {
    const exp = await this.experienceStore.get(experienceId);
    if (!exp) return null;
    const validPolarity = ['positive', 'negative', 'neutral'].includes(polarity) ? polarity : 'neutral';
    const weight = FEEDBACK_WEIGHTS[source] ?? FEEDBACK_WEIGHTS.implicit_inference;
    const entry = {
      id: crypto.randomUUID(),
      polarity: validPolarity,
      source: sanitizeLearningString(source, 60),
      weight,
      reason: sanitizeLearningString(reason, 280),
      correction: sanitizeLearningString(correction, 280),
      metrics: sanitizeLearningData(metrics && typeof metrics === 'object' ? metrics : {}),
      recorded_at: new Date(this.now()).toISOString()
    };

    const nextFeedback = [...(Array.isArray(exp.feedback) ? exp.feedback : []), entry].slice(-20);
    // Feedback explícito humano eleva significância para garantir reflexão
    const nextSignificance = (source === 'human_correction' || source === 'owner_explicit') && exp.significance === 'low'
      ? 'high'
      : exp.significance;
    const nextOutcome = (source === 'human_correction' && validPolarity === 'negative')
      ? 'failure'
      : exp.outcome;

    return this.experienceStore.store.upsertInCollection('experiences', 'lia_experiences', {
      ...exp,
      feedback: nextFeedback,
      significance: nextSignificance,
      outcome: nextOutcome,
      reflected: false
    });
  }

  summarize(experience) {
    const list = Array.isArray(experience?.feedback) ? experience.feedback : [];
    let score = 0;
    let totalWeight = 0;
    let hasExplicitHuman = false;
    for (const item of list) {
      const w = Number(item.weight || 1);
      totalWeight += w;
      if (item.polarity === 'positive') score += w;
      else if (item.polarity === 'negative') score -= w;
      if (item.source === 'human_correction' || item.source === 'owner_explicit') hasExplicitHuman = true;
    }
    const normalized = totalWeight > 0 ? Number((score / totalWeight).toFixed(3)) : 0;
    return {
      count: list.length,
      weightedScore: normalized,
      polarity: normalized > 0.15 ? 'positive' : (normalized < -0.15 ? 'negative' : 'neutral'),
      hasExplicitHuman
    };
  }
}
