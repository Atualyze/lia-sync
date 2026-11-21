import crypto from 'node:crypto';
import { sanitizeLearningData, sanitizeLearningString } from './boundary.mjs';
import { LEARNING_SCOPES } from './experience.mjs';
import { deriveConfidenceStatus } from './knowledge.mjs';

export const STRATEGY_STATUSES = Object.freeze(['draft', 'experimental', 'active', 'deprecated', 'disabled']);
export const EXPERIMENT_STATUSES = Object.freeze(['running', 'completed', 'rolled_back', 'stopped']);

const SCOPE_SET = new Set(LEARNING_SCOPES);
const STRATEGY_STATUS_SET = new Set(STRATEGY_STATUSES);

const FORBIDDEN_EXPERIMENT_PATTERN = /\b(?:pix|cobranc\w*|transfer[eê]ncia|pagament\w*|bypass|ignorar\s+opt[- ]?out|spam|sem\s+consentimento|alterar\s+c[oó]digo|permiss[aã]o|secret|credencial)\b/i;

export function validateExperimentSafety(spec = {}) {
  const serialized = JSON.stringify({
    metric: spec.metric,
    population: spec.population,
    control: spec.control,
    variant: spec.variant,
    metadata: spec.metadata
  });
  if (spec.involvesPix === true || spec.involvesFinancialTransfer === true || spec.bypassesOptOut === true || spec.bypassesOutboundGuard === true) {
    return { safe: false, reason: 'experiment_violates_safety_policy' };
  }
  if (FORBIDDEN_EXPERIMENT_PATTERN.test(serialized)) {
    return { safe: false, reason: 'experiment_contains_forbidden_action' };
  }
  const sampleLimit = Number(spec.sampleLimit ?? spec.sample_limit ?? 100);
  if (!Number.isFinite(sampleLimit) || sampleLimit < 2 || sampleLimit > 10000) {
    return { safe: false, reason: 'invalid_sample_limit' };
  }
  const riskLimit = Number(spec.riskLimit ?? spec.risk_limit ?? 0.1);
  if (!Number.isFinite(riskLimit) || riskLimit <= 0 || riskLimit > 0.5) {
    return { safe: false, reason: 'invalid_risk_limit' };
  }
  return { safe: true };
}

export class HypothesisEngine {
  constructor({ store, now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
  }

  async create({
    statement,
    scope = 'business',
    metric = 'reply_rate',
    evidence = [],
    confidence = 0.5,
    metadata = {}
  } = {}) {
    const cleanStatement = sanitizeLearningString(statement, 400).trim();
    if (!cleanStatement) throw new Error('hypothesis_statement_required');
    const cleanScope = SCOPE_SET.has(scope) ? scope : 'business';
    const nowIso = new Date(this.now()).toISOString();
    const record = {
      id: crypto.randomUUID(),
      statement: cleanStatement,
      scope: cleanScope,
      metric: sanitizeLearningString(metric, 80) || 'reply_rate',
      evidence: Array.isArray(evidence) ? sanitizeLearningData(evidence).slice(-30) : [],
      confidence: Number(Math.max(0.1, Math.min(0.7, Number(confidence) || 0.5)).toFixed(4)),
      positive_evidence: 0,
      negative_evidence: 0,
      status: 'candidate',
      metadata: sanitizeLearningData(metadata && typeof metadata === 'object' ? metadata : {}),
      created_at: nowIso,
      updated_at: nowIso
    };
    return this.store.upsertInCollection('hypotheses', 'lia_hypotheses', record);
  }

  async get(id) {
    return this.store.getFromCollection('hypotheses', 'lia_hypotheses', id);
  }

  async list({ status = null, scope = null } = {}) {
    const all = await this.store.listCollection('hypotheses', 'lia_hypotheses', 200);
    return all.filter(item => {
      if (status && item.status !== status) return false;
      if (scope && item.scope !== scope) return false;
      return true;
    });
  }

  async recordEvidence(id, { positive = true, weight = 1, note = '' } = {}) {
    const current = await this.get(id);
    if (!current) return null;
    const w = Math.max(0.25, Math.min(3, Number(weight) || 1));
    const pos = Number(current.positive_evidence || 0) + (positive ? 1 : 0);
    const neg = Number(current.negative_evidence || 0) + (positive ? 0 : 1);
    const total = pos + neg;
    const delta = positive
      ? (1 - Number(current.confidence)) * (0.15 * w)
      : -Number(current.confidence) * (0.22 * w);
    const nextConf = Number(Math.max(0, Math.min(1, Number(current.confidence) + delta)).toFixed(4));
    const nextStatus = deriveConfidenceStatus({
      confidence: nextConf,
      evidenceCount: total,
      positiveEvidence: pos,
      negativeEvidence: neg
    });
    const nextEvidence = [
      ...(Array.isArray(current.evidence) ? current.evidence : []),
      { at: new Date(this.now()).toISOString(), positive, weight: w, note: sanitizeLearningString(note, 180) }
    ].slice(-50);

    return this.store.upsertInCollection('hypotheses', 'lia_hypotheses', {
      ...current,
      confidence: nextConf,
      positive_evidence: pos,
      negative_evidence: neg,
      status: nextStatus,
      evidence: nextEvidence
    });
  }
}

export class StrategyRegistry {
  constructor({ store, now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
  }

  async createVersion({
    strategyKey,
    scope = 'business',
    status = 'draft',
    confidence = 0.5,
    definition = {},
    metrics = {},
    metadata = {}
  } = {}) {
    const cleanKey = sanitizeLearningString(strategyKey, 100).trim();
    if (!cleanKey) throw new Error('strategy_key_required');
    const cleanScope = SCOPE_SET.has(scope) ? scope : 'business';
    const cleanStatus = STRATEGY_STATUS_SET.has(status) ? status : 'draft';
    const existing = (await this.list({ strategyKey: cleanKey, scope: cleanScope }));
    const nextVersion = existing.reduce((max, item) => Math.max(max, Number(item.version || 0)), 0) + 1;
    const nowIso = new Date(this.now()).toISOString();
    const record = {
      id: crypto.randomUUID(),
      strategy_key: cleanKey,
      version: nextVersion,
      scope: cleanScope,
      status: cleanStatus,
      confidence: Number(Math.max(0, Math.min(1, Number(confidence) || 0.5)).toFixed(4)),
      definition: sanitizeLearningData(definition && typeof definition === 'object' ? definition : {}),
      metrics: sanitizeLearningData(metrics && typeof metrics === 'object' ? metrics : {}),
      metadata: sanitizeLearningData(metadata && typeof metadata === 'object' ? metadata : {}),
      created_at: nowIso,
      updated_at: nowIso
    };
    return this.store.upsertInCollection('strategies', 'lia_strategies', record);
  }

  async get(id) {
    return this.store.getFromCollection('strategies', 'lia_strategies', id);
  }

  async list({ strategyKey = null, scope = null, status = null } = {}) {
    const all = await this.store.listCollection('strategies', 'lia_strategies', 300);
    return all.filter(item => {
      if (strategyKey && item.strategy_key !== strategyKey) return false;
      if (scope && item.scope !== scope) return false;
      if (status && item.status !== status) return false;
      return true;
    });
  }

  async setStatus(id, status, patch = {}) {
    if (!STRATEGY_STATUS_SET.has(status)) throw new Error('invalid_strategy_status');
    const current = await this.get(id);
    if (!current) return null;
    return this.store.upsertInCollection('strategies', 'lia_strategies', {
      ...current,
      ...patch,
      status,
      metrics: patch.metrics ? { ...(current.metrics || {}), ...sanitizeLearningData(patch.metrics) } : current.metrics
    });
  }

  async activate(id, metrics = null) {
    const target = await this.get(id);
    if (!target) return null;
    // Depreca versões ativas anteriores do mesmo strategy_key + scope sem apagar histórico
    const peers = await this.list({ strategyKey: target.strategy_key, scope: target.scope, status: 'active' });
    for (const peer of peers) {
      if (peer.id !== target.id) {
        await this.setStatus(peer.id, 'deprecated');
      }
    }
    return this.setStatus(id, 'active', metrics ? { metrics } : {});
  }

  async deprecate(id) {
    return this.setStatus(id, 'deprecated');
  }

  async disable(id) {
    return this.setStatus(id, 'disabled');
  }

  /**
   * Seleciona a melhor estratégia ativa com base em evidência/confiança para o escopo.
   * Nunca vaza estratégia `individual` para outros escopos.
   */
  async selectBest({ strategyKey, scope = 'business' } = {}) {
    const active = await this.list({ strategyKey, status: 'active' });
    const allowedScopes = scope === 'global'
      ? ['global']
      : scope === 'business'
        ? ['business', 'global']
        : [scope, 'business', 'global'];
    const candidates = active.filter(item => allowedScopes.includes(item.scope));
    if (!candidates.length) return null;
    const scopeRank = s => allowedScopes.indexOf(s);
    candidates.sort((a, b) => {
      const rankDiff = scopeRank(a.scope) - scopeRank(b.scope);
      if (rankDiff !== 0) return rankDiff;
      return Number(b.confidence || 0) - Number(a.confidence || 0);
    });
    return candidates[0];
  }
}

export function evaluateExperiment(experiment) {
  const samples = experiment?.samples || {};
  const control = samples.control || { total: 0, successes: 0, complaints: 0, failures: 0 };
  const variant = samples.variant || { total: 0, successes: 0, complaints: 0, failures: 0 };
  const controlRate = control.total > 0 ? control.successes / control.total : 0;
  const variantRate = variant.total > 0 ? variant.successes / variant.total : 0;
  const variantComplaintRate = variant.total > 0 ? variant.complaints / variant.total : 0;
  const variantFailureRate = variant.total > 0 ? variant.failures / variant.total : 0;
  const absoluteLift = Number((variantRate - controlRate).toFixed(4));
  const relativeLiftPct = controlRate > 0
    ? Number((((variantRate - controlRate) / controlRate) * 100).toFixed(2))
    : (variantRate > 0 ? 100 : 0);
  const totalSamples = Number(control.total || 0) + Number(variant.total || 0);
  const threshold = Number(experiment?.success_threshold ?? 0.05);
  const minSamplesPerArm = Math.min(20, Math.max(2, Math.floor(Number(experiment?.sample_limit || 100) / 4)));
  const hasAdequateSample = control.total >= minSamplesPerArm && variant.total >= minSamplesPerArm;

  let winner = 'inconclusive';
  if (hasAdequateSample) {
    if (absoluteLift >= threshold) winner = 'variant';
    else if (absoluteLift <= -threshold) winner = 'control';
  }

  return {
    metric: experiment?.metric || 'reply_rate',
    totalSamples,
    controlRate: Number(controlRate.toFixed(4)),
    variantRate: Number(variantRate.toFixed(4)),
    absoluteLift,
    relativeLiftPct,
    variantComplaintRate: Number(variantComplaintRate.toFixed(4)),
    variantFailureRate: Number(variantFailureRate.toFixed(4)),
    hasAdequateSample,
    winner
  };
}

export class ExperimentEngine {
  constructor({ store, isSuppressed = null, now = () => Date.now() } = {}) {
    this.store = store;
    this.isSuppressed = isSuppressed;
    this.now = now;
  }

  async create(spec = {}) {
    const safety = validateExperimentSafety(spec);
    if (!safety.safe) {
      throw new Error(safety.reason);
    }
    const nowIso = new Date(this.now()).toISOString();
    const record = {
      id: crypto.randomUUID(),
      hypothesis_id: spec.hypothesisId || spec.hypothesis_id || null,
      metric: sanitizeLearningString(spec.metric || 'reply_rate', 80),
      population: sanitizeLearningString(spec.population || 'default', 120),
      control: sanitizeLearningData(spec.control && typeof spec.control === 'object' ? spec.control : {}),
      variant: sanitizeLearningData(spec.variant && typeof spec.variant === 'object' ? spec.variant : {}),
      duration_ms: Math.max(60_000, Number(spec.durationMs ?? spec.duration_ms ?? 7 * 86400000)),
      sample_limit: Math.max(2, Math.min(10000, Number(spec.sampleLimit ?? spec.sample_limit ?? 100))),
      risk_limit: Number(spec.riskLimit ?? spec.risk_limit ?? 0.1),
      success_threshold: Number(spec.successThreshold ?? spec.success_threshold ?? 0.05),
      rollback_condition: sanitizeLearningData(
        spec.rollbackCondition && typeof spec.rollbackCondition === 'object'
          ? spec.rollbackCondition
          : { maxComplaintRate: Number(spec.riskLimit ?? spec.risk_limit ?? 0.1), maxFailureRate: 0.35 }
      ),
      status: 'running',
      samples: {
        control: { total: 0, successes: 0, complaints: 0, failures: 0 },
        variant: { total: 0, successes: 0, complaints: 0, failures: 0 }
      },
      evaluation: {},
      metadata: sanitizeLearningData(spec.metadata && typeof spec.metadata === 'object' ? spec.metadata : {}),
      created_at: nowIso,
      updated_at: nowIso,
      ended_at: null
    };
    return this.store.upsertInCollection('experiments', 'lia_experiments', record);
  }

  async get(id) {
    return this.store.getFromCollection('experiments', 'lia_experiments', id);
  }

  async list({ status = null } = {}) {
    const all = await this.store.listCollection('experiments', 'lia_experiments', 200);
    return status ? all.filter(item => item.status === status) : all;
  }

  async canEnrollTarget({ phone = '', optOut = false, withinBusinessHours = true, outboundAllowed = true } = {}) {
    if (optOut === true) return { allowed: false, reason: 'recipient_opted_out' };
    if (withinBusinessHours === false) return { allowed: false, reason: 'outside_business_hours' };
    if (outboundAllowed === false) return { allowed: false, reason: 'outbound_guard_blocked' };
    if (phone && typeof this.isSuppressed === 'function') {
      const suppressed = await this.isSuppressed(phone);
      if (suppressed) return { allowed: false, reason: 'recipient_suppressed' };
    }
    return { allowed: true };
  }

  async recordSample(experimentId, { arm = 'variant', success = false, complaint = false, failure = false, phone = '', optOut = false, outboundAllowed = true } = {}) {
    const exp = await this.get(experimentId);
    if (!exp || exp.status !== 'running') return { accepted: false, reason: 'experiment_not_running', experiment: exp };
    const guard = await this.canEnrollTarget({ phone, optOut, outboundAllowed });
    if (!guard.allowed) return { accepted: false, reason: guard.reason, experiment: exp };

    const armKey = arm === 'control' ? 'control' : 'variant';
    const totalBefore = Number(exp.samples?.control?.total || 0) + Number(exp.samples?.variant?.total || 0);
    if (totalBefore >= Number(exp.sample_limit || 100)) {
      const closed = await this.stop(experimentId, 'completed');
      return { accepted: false, reason: 'sample_limit_reached', experiment: closed };
    }

    const nextSamples = {
      control: { ...(exp.samples?.control || { total: 0, successes: 0, complaints: 0, failures: 0 }) },
      variant: { ...(exp.samples?.variant || { total: 0, successes: 0, complaints: 0, failures: 0 }) }
    };
    nextSamples[armKey].total += 1;
    if (success) nextSamples[armKey].successes += 1;
    if (complaint) nextSamples[armKey].complaints += 1;
    if (failure) nextSamples[armKey].failures += 1;

    const draft = { ...exp, samples: nextSamples };
    const evaluation = evaluateExperiment(draft);
    const maxComplaint = Number(exp.rollback_condition?.maxComplaintRate ?? exp.risk_limit ?? 0.1);
    const maxFailure = Number(exp.rollback_condition?.maxFailureRate ?? 0.35);

    let nextStatus = 'running';
    let endedAt = null;
    let rollbackReason = null;
    const totalAfter = nextSamples.control.total + nextSamples.variant.total;

    if (nextSamples.variant.total >= 2 && (evaluation.variantComplaintRate > maxComplaint || evaluation.variantFailureRate > maxFailure)) {
      nextStatus = 'rolled_back';
      endedAt = new Date(this.now()).toISOString();
      rollbackReason = evaluation.variantComplaintRate > maxComplaint ? 'complaint_rate_exceeded' : 'failure_rate_exceeded';
    } else if (totalAfter >= Number(exp.sample_limit || 100)) {
      nextStatus = 'completed';
      endedAt = new Date(this.now()).toISOString();
    }

    const saved = await this.store.upsertInCollection('experiments', 'lia_experiments', {
      ...draft,
      status: nextStatus,
      evaluation,
      ended_at: endedAt,
      metadata: {
        ...(exp.metadata || {}),
        ...(rollbackReason ? { rollback_reason: rollbackReason } : {})
      }
    });
    return { accepted: true, rolledBack: nextStatus === 'rolled_back', completed: nextStatus === 'completed', experiment: saved };
  }

  async stop(experimentId, finalStatus = 'stopped') {
    const exp = await this.get(experimentId);
    if (!exp) return null;
    const status = EXPERIMENT_STATUSES.includes(finalStatus) ? finalStatus : 'stopped';
    const evaluation = evaluateExperiment(exp);
    return this.store.upsertInCollection('experiments', 'lia_experiments', {
      ...exp,
      status,
      evaluation,
      ended_at: exp.ended_at || new Date(this.now()).toISOString()
    });
  }
}
