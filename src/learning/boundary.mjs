export const SELF_IMPROVEMENT_ALLOW = Object.freeze(new Set([
  'memory_update',
  'strategy_update',
  'priority_adaptation',
  'tool_selection_improvement',
  'planning_improvement',
  'experimental_behavior'
]));

export const SELF_IMPROVEMENT_DENY = Object.freeze(new Set([
  'production_code_modification',
  'security_policy_modification',
  'permission_escalation',
  'secret_access_expansion',
  'authentication_changes',
  'safety_bypass'
]));

const SENSITIVE_KEY_RE = /(?:token|secret|password|passwd|apikey|api_key|authorization|cookie|private_key|service_role|jwt|bearer|credential)/i;
const SENSITIVE_VALUE_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,})\b/g;

export function sanitizeLearningString(value, maxLen = 600) {
  return String(value ?? '')
    .replace(SENSITIVE_VALUE_RE, '[redacted]')
    .slice(0, maxLen);
}

export function sanitizeLearningData(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeLearningString(value, 600);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeLearningData(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 40)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      out[key] = sanitizeLearningData(val, depth + 1);
    }
    return out;
  }
  return sanitizeLearningString(value, 200);
}

/**
 * Política explícita de fronteira de autoaperfeiçoamento.
 * Ações em DENY nunca são executadas autonomamente; devem virar
 * `improvement_proposal` aguardando revisão humana/engenharia.
 */
export function enforceSelfImprovementBoundary(actionType, details = {}) {
  const normalized = String(actionType || '').trim().toLowerCase();
  if (SELF_IMPROVEMENT_DENY.has(normalized)) {
    return {
      allowed: false,
      requiresHumanProposal: true,
      actionType: normalized,
      reason: `Ação "${normalized}" está bloqueada pela política de fronteira de autoaperfeiçoamento.`
    };
  }
  if (SELF_IMPROVEMENT_ALLOW.has(normalized)) {
    return {
      allowed: true,
      requiresHumanProposal: false,
      actionType: normalized,
      details: sanitizeLearningData(details)
    };
  }
  return {
    allowed: false,
    requiresHumanProposal: true,
    actionType: normalized || 'unknown',
    reason: `Ação "${normalized || 'unknown'}" não está na allowlist de autoaperfeiçoamento (fail-closed).`
  };
}
