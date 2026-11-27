export const PERMISSION_CATEGORIES = Object.freeze({
  A_INTERNAL: 'internal_autonomy',
  B_PREAUTHORIZED: 'preauthorized',
  C_CONFIRMATION_REQUIRED: 'confirmation_required',
  D_FORBIDDEN: 'forbidden'
});

const CATEGORY_A_ACTIONS = new Set([
  'research',
  'analyze',
  'classify',
  'update_memory',
  'create_hypothesis',
  'evaluate_strategy',
  'prepare_content',
  'create_internal_task',
  'organize_data',
  'observe',
  'investigate',
  'learn'
]);

const CATEGORY_B_ACTIONS = new Set([
  'follow_up',
  'commercial_message',
  'crm_update',
  'create_calendar_event',
  'preapproved_operation',
  'support_action'
]);

const CATEGORY_C_ACTIONS = new Set([
  'financial_transfer',
  'pix_charge',
  'irreversible_action',
  'critical_deletion',
  'high_impact_operation',
  'permission_change',
  'sensitive_data_access'
]);

const CATEGORY_D_ACTIONS = new Set([
  'bypass_policy',
  'remove_controls',
  'falsify_evidence',
  'hide_actions',
  'self_elevate_permissions',
  'modify_security_mechanisms',
  'edit_production_code'
]);

export function classifyActionCategory(actionType = '') {
  const key = String(actionType || '').trim().toLowerCase();
  if (CATEGORY_D_ACTIONS.has(key)) return PERMISSION_CATEGORIES.D_FORBIDDEN;
  if (CATEGORY_C_ACTIONS.has(key)) return PERMISSION_CATEGORIES.C_CONFIRMATION_REQUIRED;
  if (CATEGORY_B_ACTIONS.has(key)) return PERMISSION_CATEGORIES.B_PREAUTHORIZED;
  if (CATEGORY_A_ACTIONS.has(key)) return PERMISSION_CATEGORIES.A_INTERNAL;
  return PERMISSION_CATEGORIES.C_CONFIRMATION_REQUIRED; // fail-closed para ações desconhecidas
}

export function normalizeOrgAutonomyPolicy(raw = {}) {
  const level = ['passive', 'assisted', 'supervised_autonomous'].includes(raw.autonomy_level)
    ? raw.autonomy_level
    : 'assisted';
  const limits = raw.daily_limits && typeof raw.daily_limits === 'object' ? raw.daily_limits : {};
  return {
    tenant_id: String(raw.tenant_id || 'default').trim().slice(0, 80) || 'default',
    autonomy_level: level,
    allowed_actions: Array.isArray(raw.allowed_actions)
      ? raw.allowed_actions.map(a => String(a || '').trim().toLowerCase()).filter(a => CATEGORY_B_ACTIONS.has(a))
      : [],
    approval_policy: {
      requireHumanForOutbound: raw.approval_policy?.requireHumanForOutbound !== false,
      ...(raw.approval_policy && typeof raw.approval_policy === 'object' ? raw.approval_policy : {}),
      requireHumanForPix: true // imutável: Pix sempre exige confirmação (vence qualquer valor vindo de raw)
    },
    daily_limits: {
      maxActionsPerHour: Math.max(1, Number(limits.maxActionsPerHour ?? 30)),
      maxOutboundPerDay: Math.max(0, Number(limits.maxOutboundPerDay ?? 50)),
      maxExperimentsPerDay: Math.max(0, Number(limits.maxExperimentsPerDay ?? 3)),
      maxConcurrentTasks: Math.max(1, Number(limits.maxConcurrentTasks ?? 4)),
      maxAutonomousRetries: Math.max(0, Number(limits.maxAutonomousRetries ?? 2)),
      maxReflectionCostUsd: Math.max(0, Number(limits.maxReflectionCostUsd ?? 2.0))
    },
    business_hours: raw.business_hours && typeof raw.business_hours === 'object' ? { ...raw.business_hours } : { enabled: false },
    communication_policy: {
      cooldownMs: Math.max(60_000, Number(raw.communication_policy?.cooldownMs ?? 30 * 60 * 1000)),
      maxProactivePerDay: Math.max(1, Number(raw.communication_policy?.maxProactivePerDay ?? 12))
    },
    learning_policy: {
      enabled: raw.learning_policy?.enabled !== false
    },
    experiment_policy: {
      enabled: raw.experiment_policy?.enabled !== false
    }
  };
}

export class PermissionEngine {
  constructor({ isSuppressed = null } = {}) {
    this.isSuppressed = isSuppressed;
  }

  async authorize({
    actionType,
    orgPolicy = {},
    explicitConfirmation = false,
    targetPhone = '',
    optOut = false,
    withinBusinessHours = true,
    uncertainState = false
  } = {}) {
    const policy = normalizeOrgAutonomyPolicy(orgPolicy);
    const category = classifyActionCategory(actionType);
    const key = String(actionType || '').trim().toLowerCase();

    if (category === PERMISSION_CATEGORIES.D_FORBIDDEN) {
      return {
        allowed: false,
        category,
        decision: 'forbidden',
        reason: `Ação "${key}" é estritamente proibida pela política de segurança.`
      };
    }

    if (uncertainState === true && category !== PERMISSION_CATEGORIES.A_INTERNAL) {
      return {
        allowed: false,
        category,
        decision: 'blocked_uncertain',
        reason: 'Efeito externo em estado incerto bloqueia repetição ou execução automática.'
      };
    }

    if (category === PERMISSION_CATEGORIES.C_CONFIRMATION_REQUIRED) {
      if (explicitConfirmation === true && key !== 'permission_change') {
        return {
          allowed: true,
          category,
          decision: 'confirmed_by_human',
          reason: 'Ação sensível explicitamente confirmada pelo responsável.'
        };
      }
      return {
        allowed: false,
        category,
        decision: 'requires_confirmation',
        reason: `Ação "${key}" exige confirmação humana explícita.`
      };
    }

    if (category === PERMISSION_CATEGORIES.B_PREAUTHORIZED) {
      if (optOut === true) {
        return { allowed: false, category, decision: 'blocked_opt_out', reason: 'Contato solicitou opt-out.' };
      }
      if (targetPhone && typeof this.isSuppressed === 'function' && await this.isSuppressed(targetPhone)) {
        return { allowed: false, category, decision: 'blocked_suppressed', reason: 'Contato está na lista de supressão.' };
      }
      if (withinBusinessHours === false && ['follow_up', 'commercial_message'].includes(key)) {
        return { allowed: false, category, decision: 'deferred_business_hours', reason: 'Fora da janela de atendimento.' };
      }
      const preapproved = policy.allowed_actions.includes(key) && policy.autonomy_level !== 'passive';
      if (preapproved || explicitConfirmation === true) {
        return {
          allowed: true,
          category,
          decision: explicitConfirmation ? 'confirmed_by_human' : 'preapproved_policy',
          reason: explicitConfirmation ? 'Autorizado explicitamente.' : `Ação "${key}" previamente autorizada na política da organização.`
        };
      }
      return {
        allowed: false,
        category,
        decision: 'requires_authorization',
        reason: `Ação "${key}" não possui pré-autorização persistente na organização.`
      };
    }

    // Category A — Autonomia interna
    return {
      allowed: true,
      category,
      decision: 'internal_autonomy',
      reason: 'Ação interna segura permitida sem confirmação.'
    };
  }
}

export class AutonomyBudget {
  constructor({ limits = {}, now = () => Date.now() } = {}) {
    this.now = now;
    this.limits = {
      maxActionsPerHour: Math.max(1, Number(limits.maxActionsPerHour ?? 30)),
      maxOutboundPerDay: Math.max(0, Number(limits.maxOutboundPerDay ?? 50)),
      maxExperimentsPerDay: Math.max(0, Number(limits.maxExperimentsPerDay ?? 3)),
      maxConcurrentTasks: Math.max(1, Number(limits.maxConcurrentTasks ?? 4)),
      maxAutonomousRetries: Math.max(0, Number(limits.maxAutonomousRetries ?? 2))
    };
    this.actionTimestamps = [];
    this.outboundTimestamps = [];
    this.experimentTimestamps = [];
  }

  _prune(list, windowMs) {
    const cutoff = this.now() - windowMs;
    while (list.length && list[0] < cutoff) list.shift();
  }

  checkAndConsume(kind = 'action', { activeTasks = 0 } = {}) {
    const current = this.now();
    this._prune(this.actionTimestamps, 3600_000);
    this._prune(this.outboundTimestamps, 86400_000);
    this._prune(this.experimentTimestamps, 86400_000);

    if (activeTasks >= this.limits.maxConcurrentTasks) {
      return { allowed: false, reason: 'max_concurrent_tasks_reached' };
    }
    if (this.actionTimestamps.length >= this.limits.maxActionsPerHour) {
      return { allowed: false, reason: 'max_actions_per_hour_reached' };
    }
    if (kind === 'outbound' && this.outboundTimestamps.length >= this.limits.maxOutboundPerDay) {
      return { allowed: false, reason: 'max_outbound_per_day_reached' };
    }
    if (kind === 'experiment' && this.experimentTimestamps.length >= this.limits.maxExperimentsPerDay) {
      return { allowed: false, reason: 'max_experiments_per_day_reached' };
    }

    this.actionTimestamps.push(current);
    if (kind === 'outbound') this.outboundTimestamps.push(current);
    if (kind === 'experiment') this.experimentTimestamps.push(current);
    return { allowed: true };
  }

  snapshot() {
    this._prune(this.actionTimestamps, 3600_000);
    this._prune(this.outboundTimestamps, 86400_000);
    this._prune(this.experimentTimestamps, 86400_000);
    return {
      actionsLastHour: this.actionTimestamps.length,
      outboundLastDay: this.outboundTimestamps.length,
      experimentsLastDay: this.experimentTimestamps.length,
      limits: { ...this.limits }
    };
  }
}

export function selectCostTier({ attentionScore = 0, complexity = 'low', risk = 'low' } = {}) {
  if (attentionScore < 40 && complexity === 'low' && risk === 'low') {
    return { tier: 'deterministic', useLlm: false, reason: 'Baixa importância: resolvido por regra determinística.' };
  }
  if (complexity === 'high' || risk === 'critical' || attentionScore >= 85) {
    return { tier: 'capable', useLlm: true, reason: 'Alta complexidade ou risco crítico.' };
  }
  return { tier: 'fast', useLlm: true, reason: 'Evento relevante de complexidade moderada.' };
}
