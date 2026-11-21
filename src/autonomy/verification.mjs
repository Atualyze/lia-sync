import crypto from 'node:crypto';
import { sanitizeLearningData } from '../learning/boundary.mjs';

export const VERIFICATION_STATUSES = Object.freeze(['confirmed', 'failed', 'uncertain', 'partial']);

const NON_RETRYABLE_EFFECTS = new Set(['outbound', 'pix', 'payment', 'financial', 'irreversible', 'deletion']);

/**
 * Verification Engine: compara resultado esperado vs evidência observada.
 * Nunca declara `confirmed` quando a evidência é apenas "tentativa realizada"
 * ou "mensagem enviada" sem confirmação do resultado esperado.
 */
export function verifyOutcome({
  expected = '',
  observed = {},
  requiresConfirmation = false,
  now = () => Date.now()
} = {}) {
  const verifiedAt = new Date(now()).toISOString();
  if (!observed || typeof observed !== 'object') {
    return { status: 'uncertain', expected, reason: 'missing_observation', verifiedAt };
  }
  if (observed.uncertain === true || observed.ambiguous === true) {
    return { status: 'uncertain', expected, reason: observed.reason || 'ambiguous_external_effect', verifiedAt };
  }
  if (observed.failed === true || observed.error) {
    return { status: 'failed', expected, reason: String(observed.error || observed.reason || 'execution_failed'), verifiedAt };
  }
  if (observed.attemptOnly === true || (requiresConfirmation && observed.confirmed !== true)) {
    return { status: 'partial', expected, reason: 'attempt_only_awaiting_result_confirmation', verifiedAt };
  }
  if (observed.confirmed === true || observed.resolved === true || observed.success === true) {
    return { status: 'confirmed', expected, reason: observed.reason || 'verified_by_evidence', verifiedAt };
  }
  return { status: 'uncertain', expected, reason: 'insufficient_verification_evidence', verifiedAt };
}

/**
 * Autonomous Recovery: define recuperação segura após falha.
 * Efeitos externos (outbound, Pix, pagamentos, irreversíveis) e estados `uncertain`
 * NUNCA recebem retry automático.
 */
export function planRecovery({
  errorCode = '',
  effectType = 'read_only',
  attempt = 1,
  maxRetries = 2,
  hasSafeAlternative = false
} = {}) {
  const code = String(errorCode || '').trim();
  if (code === 'AI_PROVIDER_CREDITS_EXHAUSTED' || /402|credit|billing|quota/i.test(code)) {
    return {
      action: 'pause_llm_actions',
      retryAllowed: false,
      nextState: 'blocked',
      notifyOwner: true,
      reason: 'Provedor de IA sem créditos; ações dependentes de LLM pausadas sem loop de retry.'
    };
  }
  if (NON_RETRYABLE_EFFECTS.has(String(effectType || '').toLowerCase()) || code.includes('uncertain')) {
    return {
      action: 'escalate_human',
      retryAllowed: false,
      nextState: 'needs_human',
      notifyOwner: true,
      reason: 'Efeito externo ou estado incerto: retry automático proibido.'
    };
  }
  if (attempt <= maxRetries) {
    return {
      action: 'safe_retry',
      retryAllowed: true,
      nextState: 'recovering',
      notifyOwner: false,
      reason: `Falha transitória somente-leitura (${attempt}/${maxRetries}); retry seguro permitido.`
    };
  }
  if (hasSafeAlternative) {
    return {
      action: 'use_alternative',
      retryAllowed: false,
      nextState: 'planning',
      notifyOwner: false,
      reason: 'Limite de retries atingido; acionando alternativa segura.'
    };
  }
  return {
    action: 'escalate_human',
    retryAllowed: false,
    nextState: 'needs_human',
    notifyOwner: true,
    reason: 'Falha persistente sem alternativa segura; requer intervenção humana.'
  };
}

/**
 * Self-Monitoring: analisa sinais operacionais do sistema e identifica anomalias.
 */
export function evaluateSystemHealth({
  errorRate = 0,
  uncertainTasks = 0,
  stuckTasks = 0,
  aiCreditsPaused = false,
  avgLatencyMs = 0,
  degradedStrategies = 0
} = {}) {
  const alerts = [];
  if (aiCreditsPaused) {
    alerts.push({ code: 'ai_provider_credits_exhausted', severity: 'critical', message: 'Provedor de IA sem créditos; ações LLM pausadas.' });
  }
  if (uncertainTasks > 0) {
    alerts.push({ code: 'uncertain_tasks_pending', severity: 'high', message: `${uncertainTasks} tarefa(s) em estado uncertain aguardando conferência.` });
  }
  if (stuckTasks > 0) {
    alerts.push({ code: 'stuck_tasks_detected', severity: 'high', message: `${stuckTasks} tarefa(s) presa(s) detectada(s).` });
  }
  if (errorRate >= 0.25) {
    alerts.push({ code: 'high_error_rate', severity: 'high', message: `Taxa de erro elevada (${Math.round(errorRate * 100)}%).` });
  }
  if (avgLatencyMs >= 10_000) {
    alerts.push({ code: 'high_latency', severity: 'medium', message: `Latência média elevada (${Math.round(avgLatencyMs)}ms).` });
  }
  if (degradedStrategies > 0) {
    alerts.push({ code: 'strategy_degradation', severity: 'medium', message: `${degradedStrategies} estratégia(s) em degradação.` });
  }
  return {
    healthy: alerts.every(a => a.severity !== 'critical' && a.severity !== 'high'),
    alerts
  };
}

export class AutonomyAuditStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.decisions = [];
    this.metrics = {
      autonomous_decisions: 0,
      autonomous_actions: 0,
      blocked_actions: 0,
      human_escalations: 0,
      successful_actions: 0,
      failed_actions: 0,
      uncertain_actions: 0,
      verified_outcomes: 0,
      goal_progress: 0,
      commitments_fulfilled: 0,
      commitments_missed: 0,
      learning_events: 0,
      experiments: 0,
      strategy_improvements: 0,
      proactive_messages: 0,
      proactive_message_value: 0,
      sales: {
        leads_researched: 0,
        leads_contacted: 0,
        replies: 0,
        qualified: 0,
        meetings: 0,
        proposals: 0,
        wins: 0,
        revenue: 0
      }
    };
  }

  recordDecision(contract = {}) {
    const entry = {
      id: contract.id || crypto.randomUUID(),
      tenant_id: String(contract.tenantId || 'default'),
      recorded_at: new Date(this.now()).toISOString(),
      why: String(contract.why || ''),
      goal: contract.goal || null,
      event: contract.event || null,
      context: sanitizeLearningData(contract.context || {}),
      proposed_action: String(contract.proposed_action || ''),
      expected_outcome: String(contract.expected_outcome || ''),
      risk: String(contract.risk || 'medium'),
      authorization: contract.authorization || {},
      confidence: Number(contract.confidence ?? 0.5),
      verification_plan: String(contract.verification_plan || ''),
      verification: contract.verification || null,
      outcome: contract.outcome || null,
      learning: contract.learning || null
    };
    this.decisions.push(entry);
    if (this.decisions.length > 500) this.decisions.splice(0, this.decisions.length - 500);
    this.metrics.autonomous_decisions += 1;
    return entry;
  }

  updateDecision(id, patch = {}) {
    const entry = this.decisions.find(d => d.id === id);
    if (!entry) return null;
    Object.assign(entry, sanitizeLearningData(patch));
    return entry;
  }

  increment(metricName, delta = 1) {
    if (Object.prototype.hasOwnProperty.call(this.metrics, metricName) && typeof this.metrics[metricName] === 'number') {
      this.metrics[metricName] += delta;
    } else if (Object.prototype.hasOwnProperty.call(this.metrics.sales, metricName)) {
      this.metrics.sales[metricName] += delta;
    }
  }

  getMetrics() {
    const s = this.metrics.sales;
    const contacted = Math.max(1, s.leads_contacted);
    return {
      ...this.metrics,
      sales: {
        ...s,
        reply_rate: s.leads_contacted ? Number((s.replies / contacted).toFixed(4)) : 0,
        qualification_rate: s.leads_contacted ? Number((s.qualified / contacted).toFixed(4)) : 0,
        meeting_rate: s.leads_contacted ? Number((s.meetings / contacted).toFixed(4)) : 0,
        proposal_rate: s.leads_contacted ? Number((s.proposals / contacted).toFixed(4)) : 0,
        win_rate: s.leads_contacted ? Number((s.wins / contacted).toFixed(4)) : 0
      }
    };
  }

  getAuditTrail({ tenantId = null, limit = 50 } = {}) {
    const list = tenantId ? this.decisions.filter(d => d.tenant_id === tenantId) : this.decisions;
    return list.slice(-limit);
  }
}
