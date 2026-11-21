import {
  PermissionEngine,
  AutonomyBudget,
  normalizeOrgAutonomyPolicy,
  selectCostTier
} from './permissions.mjs';
import { PresenceEngine, CommunicationGuard, resolveContextualConflict } from './presence.mjs';
import { verifyOutcome, planRecovery, evaluateSystemHealth, AutonomyAuditStore } from './verification.mjs';
import {
  createCrmPorts,
  RelationshipEngine,
  SalesAutonomy,
  SupportAutonomy,
  buildGroundedPersonalization,
  decideNextCadenceStep
} from './domains.mjs';

export const AUTONOMY_DECISIONS = Object.freeze([
  'observe',
  'wait',
  'ask_human',
  'plan',
  'execute',
  'follow_up',
  'investigate',
  'learn',
  'escalate'
]);

const PRIORITY_RANK = Object.freeze({ critical: 100, high: 75, medium: 45, low: 20 });

/**
 * Priorização multi-objetivo com proteção anti-starvation:
 * objetivos de menor prioridade ganham boost progressivo conforme o tempo sem atendimento.
 */
export function prioritizeGoalsAntiStarvation(goals = [], nowMs = Date.now()) {
  return [...goals]
    .filter(g => g && g.status === 'active')
    .map(goal => {
      const base = PRIORITY_RANK[goal.priority] ?? 45;
      const lastTouchedTs = Date.parse(goal.updated_at || goal.created_at || '') || nowMs;
      const ageHours = Math.max(0, (nowMs - lastTouchedTs) / 3600_000);
      const starvationBoost = Math.min(40, Math.floor(ageHours * 1.5));
      const deadlineBoost = goal.deadline_at && Date.parse(goal.deadline_at) - nowMs <= 24 * 3600_000 ? 25 : 0;
      return {
        goal,
        effectivePriority: base + starvationBoost + deadlineBoost
      };
    })
    .sort((a, b) => b.effectivePriority - a.effectivePriority);
}

export function createAutonomyEngine({
  runtime = null,
  learning = null,
  taskStore = null,
  crm = null,
  isSuppressed = null,
  stageOutboundDispatch = null,
  notifyProactive = null,
  getBotConfig = () => ({}),
  orgPolicies = {},
  logger = console,
  now = () => Date.now()
} = {}) {
  const permissions = new PermissionEngine({ isSuppressed });
  const presence = new PresenceEngine({ now });
  const audit = new AutonomyAuditStore({ now });
  const crmPorts = createCrmPorts(crm || {});
  const relationships = new RelationshipEngine({ learning, runtime, crm: crmPorts });
  const sales = new SalesAutonomy({ crm: crmPorts, learning, runtime, audit, now });
  const support = new SupportAutonomy({ learning, runtime, audit, now });

  const policiesByTenant = new Map();
  const budgetsByTenant = new Map();
  const commGuardsByTenant = new Map();

  const getPolicy = (tenantId = 'default') => {
    const key = String(tenantId || 'default');
    if (!policiesByTenant.has(key)) {
      const raw = orgPolicies[key] || orgPolicies.default || {};
      policiesByTenant.set(key, normalizeOrgAutonomyPolicy({ ...raw, tenant_id: key }));
    }
    return policiesByTenant.get(key);
  };

  const setOrgPolicy = (tenantId, rawPolicy = {}) => {
    const key = String(tenantId || 'default');
    const normalized = normalizeOrgAutonomyPolicy({ ...rawPolicy, tenant_id: key });
    policiesByTenant.set(key, normalized);
    budgetsByTenant.set(key, new AutonomyBudget({ limits: normalized.daily_limits, now }));
    commGuardsByTenant.set(key, new CommunicationGuard({
      cooldownMs: normalized.communication_policy.cooldownMs,
      maxPerDay: normalized.communication_policy.maxProactivePerDay,
      now
    }));
    return normalized;
  };

  const getBudget = (tenantId = 'default') => {
    const key = String(tenantId || 'default');
    if (!budgetsByTenant.has(key)) {
      const policy = getPolicy(key);
      budgetsByTenant.set(key, new AutonomyBudget({ limits: policy.daily_limits, now }));
    }
    return budgetsByTenant.get(key);
  };

  const getCommGuard = (tenantId = 'default') => {
    const key = String(tenantId || 'default');
    if (!commGuardsByTenant.has(key)) {
      const policy = getPolicy(key);
      commGuardsByTenant.set(key, new CommunicationGuard({
        cooldownMs: policy.communication_policy.cooldownMs,
        maxPerDay: policy.communication_policy.maxProactivePerDay,
        now
      }));
    }
    return commGuardsByTenant.get(key);
  };

  /**
   * Decide, autoriza, executa (quando permitido), verifica e audita uma iniciativa autônoma.
   */
  const decideAndAct = async ({
    tenantId = 'default',
    why = '',
    goal = null,
    event = null,
    context = {},
    proposedAction = 'observe',
    expectedOutcome = '',
    risk = 'low',
    confidence = 0.7,
    verificationPlan = 'confirmar retorno estruturado',
    explicitConfirmation = false,
    targetPhone = '',
    optOut = false,
    withinBusinessHours = true,
    uncertainState = false,
    execute = null,
    effectType = 'read_only',
    requiresResultConfirmation = false
  } = {}) => {
    const policy = getPolicy(tenantId);
    const budget = getBudget(tenantId);
    const costTier = selectCostTier({
      attentionScore: Number(context.attentionScore ?? (risk === 'critical' ? 90 : 60)),
      complexity: context.complexity || 'low',
      risk
    });

    presence.transition('observing', { activity: `Avaliando iniciativa: ${proposedAction}` });

    const auth = await permissions.authorize({
      actionType: proposedAction,
      orgPolicy: policy,
      explicitConfirmation,
      targetPhone,
      optOut,
      withinBusinessHours,
      uncertainState
    });

    const contract = audit.recordDecision({
      tenantId,
      why,
      goal: goal ? { id: goal.id, title: goal.title } : null,
      event: event ? { id: event.id, type: event.type } : null,
      context: { ...context, costTier: costTier.tier },
      proposed_action: proposedAction,
      expected_outcome: expectedOutcome,
      risk,
      authorization: auth,
      confidence,
      verification_plan: verificationPlan
    });

    if (!auth.allowed) {
      audit.increment('blocked_actions');
      if (auth.decision === 'requires_confirmation' || auth.decision === 'requires_authorization' || auth.decision === 'blocked_uncertain') {
        audit.increment('human_escalations');
        presence.transition('needs_human', { humanRequest: `${proposedAction}: ${auth.reason}` });
      } else {
        presence.transition('blocked', { blocker: auth.reason });
      }
      return {
        decision: auth.decision === 'forbidden' ? 'escalate' : 'ask_human',
        executed: false,
        contract,
        authorization: auth
      };
    }

    const budgetKind = ['follow_up', 'commercial_message'].includes(proposedAction) ? 'outbound' : 'action';
    const budgetCheck = budget.checkAndConsume(budgetKind);
    if (!budgetCheck.allowed) {
      audit.increment('blocked_actions');
      presence.transition('waiting', { waitingFor: budgetCheck.reason });
      audit.updateDecision(contract.id, { outcome: budgetCheck.reason });
      return {
        decision: 'wait',
        executed: false,
        contract,
        authorization: auth,
        reason: budgetCheck.reason
      };
    }

    if (typeof execute !== 'function') {
      presence.transition('available', { activity: 'Aguardando próximo evento' });
      return {
        decision: 'plan',
        executed: false,
        contract,
        authorization: auth
      };
    }

    presence.transition('working', { activity: `Executando ${proposedAction}` });
    audit.increment('autonomous_actions');

    try {
      const observed = await execute({ policy, contract, costTier });
      const verification = verifyOutcome({
        expected: expectedOutcome,
        observed,
        requiresConfirmation: requiresResultConfirmation,
        now
      });
      audit.updateDecision(contract.id, { verification, outcome: verification.status });

      if (verification.status === 'confirmed') {
        audit.increment('successful_actions');
        audit.increment('verified_outcomes');
        presence.transition('completed', { activity: `${proposedAction} confirmado` });
      } else if (verification.status === 'uncertain') {
        audit.increment('uncertain_actions');
        audit.increment('human_escalations');
        presence.transition('needs_human', { humanRequest: `Conferir resultado incerto de ${proposedAction}` });
      } else if (verification.status === 'failed') {
        audit.increment('failed_actions');
        const recovery = planRecovery({ errorCode: verification.reason, effectType });
        presence.transition(recovery.nextState === 'needs_human' ? 'needs_human' : 'recovering', {
          blocker: recovery.reason
        });
      } else {
        presence.transition('waiting', { waitingFor: `Confirmação de ${proposedAction}` });
      }

      if (learning?.available) {
        const expOutcome = verification.status === 'confirmed'
          ? 'success'
          : (verification.status === 'partial' ? 'partial_success' : verification.status);
        await learning.experiences.record({
          deduplicationKey: `autonomy:${contract.id}`,
          source: 'autonomy_engine',
          scope: targetPhone ? 'relationship' : 'business',
          subject: targetPhone || tenantId,
          goalId: goal?.id || null,
          action: proposedAction,
          expectedResult: expectedOutcome,
          actualResult: verification.reason,
          outcome: expOutcome,
          significance: verification.status === 'confirmed' ? 'medium' : 'high'
        }).catch(() => {});
        audit.increment('learning_events');
      }

      return {
        decision: 'execute',
        executed: true,
        contract,
        authorization: auth,
        verification
      };
    } catch (error) {
      const code = String(error?.code || error?.message || 'execution_error');
      audit.increment('failed_actions');
      const recovery = planRecovery({ errorCode: code, effectType });
      audit.updateDecision(contract.id, { outcome: 'failed', verification: { status: 'failed', reason: code } });
      presence.transition(recovery.nextState === 'needs_human' ? 'needs_human' : 'blocked', { blocker: recovery.reason });
      return {
        decision: recovery.action === 'escalate_human' ? 'escalate' : 'wait',
        executed: false,
        contract,
        authorization: auth,
        recovery
      };
    }
  };

  /**
   * Comunicação proativa estritamente filtrada por motivo válido, deduplicação e cooldown.
   */
  const communicateProactively = async ({
    tenantId = 'default',
    reason = '',
    deduplicationKey = '',
    subject = 'owner',
    message = '',
    relevant = true,
    userNeedsToKnow = true,
    rightTiming = true,
    permitted = true
  } = {}) => {
    const guard = getCommGuard(tenantId);
    const check = guard.evaluate({ reason, deduplicationKey, subject, relevant, userNeedsToKnow, rightTiming, permitted });
    if (!check.shouldSend) return { sent: false, reason: check.reason };
    if (!String(message || '').trim()) return { sent: false, reason: 'empty_message' };
    if (typeof notifyProactive === 'function') {
      await notifyProactive({ tenantId, subject, reason, message });
    }
    guard.markSent({ deduplicationKey, subject });
    audit.increment('proactive_messages');
    return { sent: true, reason: 'sent' };
  };

  /**
   * Revisão periódica proativa (ex.: 09:00): verifica objetivos, compromissos,
   * tarefas e saúde; dorme silenciosamente se não houver motivo real.
   */
  const runDailyReview = async ({ tenantId = 'default', rightTiming = true } = {}) => {
    const activeGoals = runtime?.available ? await runtime.goals.list({ status: 'active' }) : [];
    const pendingCommitments = runtime?.available ? await runtime.commitments.list({ status: 'pending' }) : [];
    const prioritized = prioritizeGoalsAntiStarvation(activeGoals, now());
    const health = evaluateSystemHealth({
      aiCreditsPaused: Boolean(learning?.aiCreditsPaused),
      uncertainTasks: audit.metrics.uncertain_actions
    });

    const hasRelevantWork = prioritized.length > 0 || pendingCommitments.length > 0 || !health.healthy;
    if (!hasRelevantWork) {
      presence.transition('available', { activity: 'Revisão diária sem pendências relevantes; dormindo.' });
      return { woke: true, notified: false, prioritizedGoals: [], pendingCommitments: 0, health };
    }

    const lines = [
      prioritized.length ? `• Objetivos ativos priorizados: ${prioritized.length} (topo: ${prioritized[0].goal.title})` : '',
      pendingCommitments.length ? `• Compromissos pendentes: ${pendingCommitments.length}` : '',
      !health.healthy ? `• Alertas operacionais: ${health.alerts.map(a => a.code).join(', ')}` : ''
    ].filter(Boolean).join('\n');

    const dateKey = new Date(now()).toISOString().slice(0, 10);
    const comm = await communicateProactively({
      tenantId,
      reason: 'daily_review',
      deduplicationKey: `daily_review:${tenantId}:${dateKey}`,
      subject: `owner:${tenantId}`,
      message: `Resumo operacional real:\n${lines}`,
      rightTiming
    });

    return {
      woke: true,
      notified: comm.sent,
      prioritizedGoals: prioritized.map(p => p.goal),
      pendingCommitments: pendingCommitments.length,
      health
    };
  };

  const readiness = () => {
    const runtimeReady = runtime ? runtime.available === true : true;
    const learningReady = learning ? learning.available === true : true;
    const ok = runtimeReady && learningReady;
    return {
      name: 'lia_autonomy',
      status: ok ? 'ready' : 'unavailable',
      presence: presence.state,
      ...(ok ? {} : { reason: !runtimeReady ? 'runtime_unavailable' : 'learning_unavailable' })
    };
  };

  return {
    permissions,
    presence,
    audit,
    crm: crmPorts,
    relationships,
    sales,
    support,
    getPolicy,
    setOrgPolicy,
    getBudget,
    decideAndAct,
    communicateProactively,
    runDailyReview,
    resolveContextualConflict,
    buildGroundedPersonalization,
    decideNextCadenceStep,
    stageOutboundDispatch,
    readiness,
    getMetrics: () => audit.getMetrics(),
    getAuditTrail: (opts) => audit.getAuditTrail(opts)
  };
}
