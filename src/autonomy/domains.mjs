import { sanitizeLearningData, sanitizeLearningString } from '../learning/boundary.mjs';

export const SALES_STATES = Object.freeze([
  'new',
  'researched',
  'contacted',
  'engaged',
  'qualified',
  'opportunity',
  'proposal',
  'negotiation',
  'won',
  'lost'
]);

const SALES_STATE_SET = new Set(SALES_STATES);

/**
 * Interfaces/Ports desacopladas de CRM (compatível com Deskcomm, HubSpot, Pipedrive ou adaptador local).
 */
export function createCrmPorts(overrides = {}) {
  const noop = async () => null;
  const noopList = async () => [];
  return {
    LeadProvider: overrides.LeadProvider || { findEligible: noopList, getById: noop, update: noop },
    ContactProvider: overrides.ContactProvider || { getByPhone: noop, upsert: noop },
    CompanyProvider: overrides.CompanyProvider || { getById: noop, upsert: noop },
    OpportunityProvider: overrides.OpportunityProvider || { listByContact: noopList, upsert: noop },
    ActivityProvider: overrides.ActivityProvider || { record: noop, listRecent: noopList },
    PipelineProvider: overrides.PipelineProvider || { getStages: async () => [...SALES_STATES] }
  };
}

/**
 * Scoring determinístico baseado em fatores verificáveis (não "o LLM acha que é quente").
 */
export function scoreLead({
  icpFit = 0,
  intent = 0,
  engagement = 0,
  problem = 0,
  urgency = 0,
  capacity = 0,
  history = 0
} = {}) {
  const clamp01 = v => Number(Math.max(0, Math.min(1, Number(v) || 0)).toFixed(2));
  const factors = {
    icpFit: clamp01(icpFit),
    intent: clamp01(intent),
    engagement: clamp01(engagement),
    problem: clamp01(problem),
    urgency: clamp01(urgency),
    capacity: clamp01(capacity),
    history: clamp01(history)
  };
  const weighted = (
    factors.icpFit * 0.25 +
    factors.intent * 0.22 +
    factors.engagement * 0.18 +
    factors.problem * 0.12 +
    factors.urgency * 0.10 +
    factors.capacity * 0.08 +
    factors.history * 0.05
  );
  return {
    score: Math.round(weighted * 100),
    factors
  };
}

/**
 * Personalização baseada estritamente em fatos reais verificados.
 * Nunca inventa faturamento, número de funcionários, problemas ou urgência.
 */
export function buildGroundedPersonalization({
  contactName = '',
  companyName = '',
  segment = '',
  verifiedProblem = '',
  buyingSignals = [],
  relationship = null,
  strategy = null
} = {}) {
  const groundedFacts = {};
  if (contactName) groundedFacts.contactName = sanitizeLearningString(contactName, 80);
  if (companyName) groundedFacts.companyName = sanitizeLearningString(companyName, 100);
  if (segment) groundedFacts.segment = sanitizeLearningString(segment, 80);
  if (verifiedProblem) groundedFacts.verifiedProblem = sanitizeLearningString(verifiedProblem, 200);
  if (Array.isArray(buyingSignals) && buyingSignals.length) {
    groundedFacts.buyingSignals = buyingSignals.slice(0, 5).map(s => sanitizeLearningString(s, 100));
  }
  if (relationship?.preferences?.style) groundedFacts.preferredStyle = relationship.preferences.style;
  if (strategy?.strategy_key) groundedFacts.strategy = `${strategy.strategy_key}@v${strategy.version}`;

  const greeting = groundedFacts.contactName ? `Olá, ${groundedFacts.contactName}` : 'Olá';
  const contextLine = groundedFacts.verifiedProblem
    ? `vi que vocês mencionaram o desafio com ${groundedFacts.verifiedProblem}`
    : (groundedFacts.companyName ? `acompanhando o contexto da ${groundedFacts.companyName}` : 'retomando nosso contato');
  return {
    groundedFacts,
    draftMessage: `${greeting}! ${contextLine}. Faz sentido darmos o próximo passo?`
  };
}

/**
 * Cadência adaptativa orientada por resposta real, respeitando opt-out e compromissos.
 */
export function decideNextCadenceStep({
  signal = 'no_reply',
  optOut = false,
  requestedFollowUpAt = null,
  attempts = 0,
  maxAttempts = 4
} = {}) {
  if (optOut === true || signal === 'opt_out') {
    return { action: 'stop_permanently', nextStage: 'lost', reason: 'opt_out_respected' };
  }
  if (signal === 'positive_reply' || signal === 'interest') {
    return { action: 'accelerate_qualification', nextStage: 'qualified', reason: 'positive_engagement' };
  }
  if (signal === 'negative_reply') {
    return { action: 'close_cadence', nextStage: 'lost', reason: 'negative_response' };
  }
  if (signal === 'ask_later' && requestedFollowUpAt) {
    return { action: 'create_commitment', dueAt: requestedFollowUpAt, nextStage: 'engaged', reason: 'contact_requested_later' };
  }
  if (attempts >= maxAttempts) {
    return { action: 'pause_cadence', nextStage: 'contacted', reason: 'max_cadence_attempts_reached' };
  }
  const delayHours = attempts === 0 ? 48 : (attempts === 1 ? 96 : 168);
  return { action: 'schedule_followup', delayHours, nextStage: 'contacted', reason: 'adaptive_no_reply_backoff' };
}

export class RelationshipEngine {
  constructor({ learning = null, runtime = null, crm = null } = {}) {
    this.learning = learning;
    this.runtime = runtime;
    this.crm = crm || createCrmPorts();
  }

  async getSituation(subject, tenantId = 'default') {
    const cleanSubject = sanitizeLearningString(subject, 120);
    const [profile, commitments, opportunities] = await Promise.all([
      this.learning?.relationships?.get(cleanSubject, tenantId).catch(() => null) ?? null,
      this.runtime?.commitments?.list().catch(() => []) ?? [],
      this.crm?.OpportunityProvider?.listByContact(cleanSubject).catch(() => []) ?? []
    ]);
    const relatedCommitments = commitments.filter(c => c.subject === cleanSubject);
    const activeCommitments = relatedCommitments.filter(c => c.status === 'pending' || c.status === 'in_progress');
    return {
      subject: cleanSubject,
      tenant_id: tenantId,
      preferences: profile?.preferences || {},
      best_hours: profile?.best_hours || [],
      interests: profile?.interests || [],
      objections: profile?.objections || [],
      commercial_stage: profile?.commercial_stage || 'new',
      last_interaction_at: profile?.last_interaction_at || null,
      active_commitments: activeCommitments,
      opportunities: Array.isArray(opportunities) ? opportunities : [],
      next_action: activeCommitments[0]
        ? `Cumprir compromisso: ${activeCommitments[0].title}`
        : (profile?.metadata?.next_action || 'observar')
    };
  }
}

export class SalesAutonomy {
  constructor({ crm = null, learning = null, runtime = null, audit = null, now = () => Date.now() } = {}) {
    this.crm = crm || createCrmPorts();
    this.learning = learning;
    this.runtime = runtime;
    this.audit = audit;
    this.now = now;
    this.states = new Map();
  }

  _key(subject, tenantId = 'default') {
    return `${tenantId}:${subject}`;
  }

  getState(subject, tenantId = 'default') {
    return this.states.get(this._key(subject, tenantId)) || null;
  }

  transition({ subject, tenantId = 'default', toStage, evidence = '', origin = 'autonomy', owner = 'lia', nextAction = '', reason = '' } = {}) {
    if (!SALES_STATE_SET.has(toStage)) throw new Error('invalid_sales_stage');
    const key = this._key(subject, tenantId);
    const prev = this.states.get(key) || {
      id: key,
      tenant_id: tenantId,
      subject,
      stage: 'new',
      score: 0,
      score_factors: {},
      next_action: '',
      transitions: []
    };
    const record = {
      from: prev.stage,
      to: toStage,
      evidence: sanitizeLearningString(evidence, 240),
      timestamp: new Date(this.now()).toISOString(),
      origin,
      owner,
      next_action: sanitizeLearningString(nextAction, 160),
      reason: sanitizeLearningString(reason, 180)
    };
    const next = {
      ...prev,
      stage: toStage,
      next_action: record.next_action,
      transitions: [...prev.transitions, record].slice(-50),
      updated_at: record.timestamp
    };
    this.states.set(key, next);

    if (toStage === 'researched') this.audit?.increment('leads_researched');
    if (toStage === 'contacted') this.audit?.increment('leads_contacted');
    if (toStage === 'engaged') this.audit?.increment('replies');
    if (toStage === 'qualified') this.audit?.increment('qualified');
    if (toStage === 'proposal') this.audit?.increment('proposals');
    if (toStage === 'won') this.audit?.increment('wins');
    return next;
  }

  evaluateLead({ subject, tenantId = 'default', factors = {} } = {}) {
    const scored = scoreLead(factors);
    const key = this._key(subject, tenantId);
    const current = this.states.get(key) || this.transition({
      subject, tenantId, toStage: 'researched', evidence: 'lead_scored', nextAction: 'avaliar_contato'
    });
    const updated = {
      ...current,
      score: scored.score,
      score_factors: scored.factors,
      updated_at: new Date(this.now()).toISOString()
    };
    this.states.set(key, updated);
    return updated;
  }
}

export class SupportAutonomy {
  constructor({ learning = null, runtime = null, audit = null, now = () => Date.now() } = {}) {
    this.learning = learning;
    this.runtime = runtime;
    this.audit = audit;
    this.now = now;
  }

  /**
   * Fluxo autônomo de atendimento orientado a resultado:
   * diagnostica -> consulta conhecimento -> executa ação permitida -> verifica resolução real.
   */
  async handleCase({
    subject,
    problemDescription,
    tenantId = 'default',
    consultKnowledge = async () => ({ found: true, solution: 'orientacao_padrao' }),
    executeAllowedAction = async () => ({ sent: true }),
    observedConfirmation = null
  } = {}) {
    const diagnosis = {
      subject: sanitizeLearningString(subject, 120),
      problem: sanitizeLearningString(problemDescription, 300),
      diagnosedAt: new Date(this.now()).toISOString()
    };

    const kb = await consultKnowledge(diagnosis);
    const actionResult = await executeAllowedAction({ diagnosis, knowledge: kb });

    // Diferencia "resposta enviada" de "problema realmente resolvido"
    const confirmedResolved = observedConfirmation?.resolved === true;
    const verificationStatus = confirmedResolved ? 'confirmed' : (actionResult?.failed ? 'failed' : 'partial');

    let followUpCommitment = null;
    if (!confirmedResolved && this.runtime?.commitments) {
      followUpCommitment = await this.runtime.commitments.create({
        title: `Verificar resolução do atendimento: ${diagnosis.problem.slice(0, 80)}`,
        subject: diagnosis.subject,
        dueAt: new Date(this.now() + 24 * 60 * 60 * 1000).toISOString(),
        metadata: { tenant_id: tenantId, kind: 'support_verification' }
      });
    }

    if (this.learning?.experiences) {
      await this.learning.experiences.record({
        deduplicationKey: `support:${diagnosis.subject}:${diagnosis.diagnosedAt}`,
        source: 'support_autonomy',
        scope: 'relationship',
        subject: diagnosis.subject,
        action: 'support_resolution',
        expectedResult: 'problema confirmado resolvido pelo cliente',
        actualResult: confirmedResolved ? 'cliente confirmou resolução' : 'ação executada, aguardando confirmação',
        outcome: confirmedResolved ? 'success' : (actionResult?.failed ? 'failure' : 'partial_success'),
        significance: confirmedResolved ? 'medium' : 'high'
      }).catch(() => {});
    }

    return {
      diagnosis,
      knowledge: sanitizeLearningData(kb),
      actionResult: sanitizeLearningData(actionResult),
      verificationStatus,
      closed: confirmedResolved,
      followUpCommitment
    };
  }
}
