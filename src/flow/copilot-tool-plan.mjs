import {
  getToolCatalog,
  getToolExecutionPolicy,
  resolveToolName,
  validateToolCallArguments
} from '../tools/index.mjs';

export const MAX_COPILOT_TOOL_STEPS = 4;

export function buildCopilotToolPlan(toolCalls = [], {
  botConfig = {},
  actor = 'owner',
  maxSteps = MAX_COPILOT_TOOL_STEPS
} = {}) {
  const limit = Math.max(1, Math.min(MAX_COPILOT_TOOL_STEPS, Number.isInteger(maxSteps) ? maxSteps : MAX_COPILOT_TOOL_STEPS));
  const catalog = new Map(getToolCatalog({ botConfig, actor, includeDisabled: true }).map(item => [item.name, item]));
  const steps = [];
  const rejected = [];
  const duplicates = [];
  const seen = new Set();
  let truncated = false;

  for (let index = 0; index < (Array.isArray(toolCalls) ? toolCalls.length : 0); index += 1) {
    const call = toolCalls[index] || {};
    const name = resolveToolName(call.name);
    const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};

    if (steps.length >= limit) {
      truncated = true;
      rejected.push({ index: index + 1, name: name || 'unknown', reason: 'step_limit_exceeded' });
      break;
    }
    if (!name || !catalog.has(name)) {
      rejected.push({ index: index + 1, name: name || 'unknown', reason: 'tool_not_in_catalog' });
      continue;
    }

    const entry = catalog.get(name);
    if (!entry.allowedForActor) {
      rejected.push({ index: index + 1, name, reason: 'tool_not_allowed_for_actor' });
      continue;
    }
    if (!entry.enabled) {
      rejected.push({ index: index + 1, name, reason: 'tool_disabled' });
      continue;
    }

    // O conteúdo de uma mensagem de saída pode ser coletado em uma etapa
    // conversacional posterior, depois da revisão semântica da intenção.
    // Ainda validamos todos os demais campos; o executor nunca recebe o
    // placeholder e só é chamado após o fluxo preencher message.
    const validationArgs = name === 'enviar_mensagem_contato' && !String(args.message || '').trim()
      ? { ...args, message: '__PENDING_MESSAGE__' }
      : args;
    const invalid = validateToolCallArguments(name, validationArgs);
    if (invalid) {
      rejected.push({ index: index + 1, name, reason: 'invalid_arguments' });
      continue;
    }

    const dedupeKey = name + ':' + JSON.stringify(args);
    if (seen.has(dedupeKey)) {
      duplicates.push({ index: index + 1, name });
      continue;
    }
    seen.add(dedupeKey);
    steps.push({
      step: steps.length + 1,
      name,
      args,
      policy: getToolExecutionPolicy(name)
    });
  }

  return {
    steps,
    rejected,
    duplicates,
    truncated,
    maxSteps: limit,
    canExecute: steps.length > 0 && rejected.length === 0 && !truncated
  };
}

export function verifyCopilotToolResult(toolName, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { state: 'unverified', continue: false, recovery: 'stop_and_report' };
  }
  if (result.requiresConfirmation === true) {
    return { state: 'awaiting_confirmation', continue: false, recovery: 'await_confirmation' };
  }
  if (result.success === false || result.error) {
    return {
      state: 'failed',
      continue: false,
      recovery: getCopilotToolRecovery(toolName, result).action
    };
  }
  if (toolName === 'consultar_saude_infra' && (result.health !== undefined || Array.isArray(result.checks))) {
    return String(result.health || '').toLowerCase() === 'healthy' || result.healthy === true
      ? { state: 'verified', continue: true, recovery: 'none' }
      : { state: 'completed_with_warnings', continue: false, recovery: 'human_review' };
  }
  if (toolName === 'consultar_contato_ou_lead' && typeof result.found === 'boolean') {
    return result.found
      ? { state: 'verified', continue: true, recovery: 'none' }
      : { state: 'no_match', continue: false, recovery: 'ask_for_contact' };
  }
  if (result.success === true) {
    return { state: 'verified', continue: true, recovery: 'none' };
  }
  return { state: 'unverified', continue: false, recovery: 'stop_and_report' };
}

export function getCopilotToolRecovery(toolName, result = {}) {
  const policy = getToolExecutionPolicy(toolName);
  const detail = String(result.error || result.message || result.code || '');
  const transient = /timeout|timed out|temporar|http\s*(?:429|500|502|503|504)|\b(?:429|500|502|503|504)\b|econnreset|enotfound|network|fetch failed/i.test(detail);

  if (result.requiresConfirmation === true) {
    return { action: 'await_confirmation', autoRetry: false };
  }
  if (policy.retry === 'read_only_after_review' && transient) {
    return { action: 'retry_after_review', autoRetry: false };
  }
  if (['external_delivery', 'payment_artifact', 'payment_checkout', 'conditional'].includes(policy.mode)) {
    return { action: 'manual_check_before_retry', autoRetry: false };
  }
  if (policy.mode === 'read_only' || policy.mode === 'read_only_untrusted_data') {
    return { action: 'report_and_offer_manual_retry', autoRetry: false };
  }
  return { action: 'stop_and_escalate', autoRetry: false };
}
