export const PRESENCE_STATES = Object.freeze([
  'available',
  'observing',
  'working',
  'waiting',
  'blocked',
  'needs_human',
  'completed',
  'recovering'
]);

const STATE_SET = new Set(PRESENCE_STATES);

const VALID_PROACTIVE_REASONS = new Set([
  'commitment_due',
  'important_result',
  'relevant_opportunity',
  'relevant_risk',
  'problem_detected',
  'task_completed',
  'task_failed',
  'important_discovery',
  'goal_achieved',
  'goal_deteriorating',
  'approval_needed',
  'daily_review'
]);

export class PresenceEngine {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.state = 'available';
    this.currentActivity = '';
    this.waitingFor = [];
    this.blockers = [];
    this.humanRequests = [];
    this.updatedAt = new Date(this.now()).toISOString();
  }

  transition(nextState, { activity = '', waitingFor = null, blocker = null, humanRequest = null } = {}) {
    if (!STATE_SET.has(nextState)) throw new Error('invalid_presence_state');
    this.state = nextState;
    if (activity !== undefined) this.currentActivity = String(activity || '').slice(0, 200);
    if (waitingFor) this.waitingFor = [...new Set([...this.waitingFor, String(waitingFor).slice(0, 120)])].slice(-20);
    if (blocker) this.blockers = [...new Set([...this.blockers, String(blocker).slice(0, 160)])].slice(-20);
    if (humanRequest) this.humanRequests = [...new Set([...this.humanRequests, String(humanRequest).slice(0, 160)])].slice(-20);
    if (nextState === 'available' || nextState === 'completed') {
      this.blockers = [];
    }
    this.updatedAt = new Date(this.now()).toISOString();
    return this.snapshot();
  }

  snapshot() {
    return {
      state: this.state,
      currentActivity: this.currentActivity,
      waitingFor: [...this.waitingFor],
      blockers: [...this.blockers],
      humanRequests: [...this.humanRequests],
      updatedAt: this.updatedAt
    };
  }
}

/**
 * Guardião de comunicação proativa: impede mensagens vazias, repetitivas ou fora de hora.
 */
export class CommunicationGuard {
  constructor({ cooldownMs = 30 * 60 * 1000, maxPerDay = 12, now = () => Date.now() } = {}) {
    this.cooldownMs = cooldownMs;
    this.maxPerDay = maxPerDay;
    this.now = now;
    this.sentByDedupeKey = new Map();
    this.lastSentBySubject = new Map();
    this.sentTimestamps = [];
  }

  evaluate({
    reason = '',
    deduplicationKey = '',
    subject = 'owner',
    relevant = true,
    userNeedsToKnow = true,
    rightTiming = true,
    permitted = true
  } = {}) {
    const current = this.now();
    const cutoffDay = current - 86400_000;
    while (this.sentTimestamps.length && this.sentTimestamps[0] < cutoffDay) this.sentTimestamps.shift();

    if (!VALID_PROACTIVE_REASONS.has(String(reason || ''))) {
      return { shouldSend: false, reason: 'no_valid_proactive_reason' };
    }
    if (!relevant || !userNeedsToKnow) {
      return { shouldSend: false, reason: 'not_relevant_for_user' };
    }
    if (!rightTiming) {
      return { shouldSend: false, reason: 'deferred_wrong_timing' };
    }
    if (!permitted) {
      return { shouldSend: false, reason: 'not_permitted' };
    }
    if (deduplicationKey && this.sentByDedupeKey.has(deduplicationKey)) {
      return { shouldSend: false, reason: 'duplicate_proactive_message' };
    }
    const lastForSubject = this.lastSentBySubject.get(subject);
    if (lastForSubject && current - lastForSubject < this.cooldownMs) {
      return { shouldSend: false, reason: 'proactive_cooldown_active' };
    }
    if (this.sentTimestamps.length >= this.maxPerDay) {
      return { shouldSend: false, reason: 'proactive_daily_cap_reached' };
    }
    return { shouldSend: true, reason: 'approved' };
  }

  markSent({ deduplicationKey = '', subject = 'owner' } = {}) {
    const current = this.now();
    if (deduplicationKey) {
      this.sentByDedupeKey.set(deduplicationKey, current);
      if (this.sentByDedupeKey.size > 2000) {
        this.sentByDedupeKey.delete(this.sentByDedupeKey.keys().next().value);
      }
    }
    this.lastSentBySubject.set(subject, current);
    this.sentTimestamps.push(current);
  }
}

/**
 * Resolve conflito quando existem múltiplos contextos pendentes (ex.: Pix + outbound uncertain + follow-up)
 * diante de uma mensagem curta como "sim". Nunca escolhe arbitrariamente sob ambiguidade ou estado incerto.
 */
export function resolveContextualConflict({ message = '', contexts = [], nowMs = Date.now() } = {}) {
  const cleanMsg = String(message || '').trim().toLowerCase();
  const active = (Array.isArray(contexts) ? contexts : []).filter(Boolean);
  if (!active.length) return { resolution: 'none', selected: null, reason: 'no_active_context' };

  const isShortAffirmation = /^(?:sim|ok|pode|confirmo|manda|envia|fechado|beleza)\b/i.test(cleanMsg) && cleanMsg.split(/\s+/).length <= 3;

  // Regra crítica: qualquer contexto `uncertain` bloqueia interpretação automática de "sim"
  const uncertain = active.filter(ctx => ctx.state === 'uncertain');
  if (isShortAffirmation && uncertain.length > 0) {
    return {
      resolution: 'clarify',
      selected: null,
      reason: 'uncertain_context_blocks_short_affirmation',
      candidates: active.map(c => c.id || c.kind)
    };
  }

  const scored = active.map(ctx => {
    const recencySec = Math.max(0, (nowMs - (Date.parse(ctx.updatedAt || '') || nowMs)) / 1000);
    const recencyScore = Math.max(0, 30 - recencySec / 120);
    const explicitScore = ctx.explicitMatch ? 40 : 0;
    const relevanceScore = Number(ctx.relevance || 50) * 0.4;
    const riskPenalty = ctx.risk === 'high' || ctx.risk === 'critical' ? 15 : 0;
    return {
      ctx,
      score: recencyScore + explicitScore + relevanceScore - (isShortAffirmation ? riskPenalty : 0)
    };
  }).sort((a, b) => b.score - a.score);

  if (scored.length === 1) {
    return { resolution: 'resolved', selected: scored[0].ctx, reason: 'single_active_context' };
  }

  const gap = scored[0].score - scored[1].score;
  if (isShortAffirmation && (gap < 20 || scored.some(s => s.ctx.risk === 'high' || s.ctx.risk === 'critical'))) {
    return {
      resolution: 'clarify',
      selected: null,
      reason: 'ambiguous_multiple_contexts',
      candidates: scored.slice(0, 3).map(s => s.ctx.id || s.ctx.kind)
    };
  }

  return { resolution: 'resolved', selected: scored[0].ctx, reason: 'highest_contextual_evidence' };
}
