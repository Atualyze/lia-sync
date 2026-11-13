// Telemetria e métricas em memória para o dashboard do Lia Sync
// Regra: logs e telemetria NUNCA devem conter texto do cliente nem telefone completo.

const MAX_HISTORY = 100;
const MAX_ERRORS = 50;

const state = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  latencies: [], // últimos 100 latências (ms)
  history: [],   // últimas 100 chamadas anonimizadas
  errors: [],    // últimos 50 erros sanitizados
  byProvider: {
    gemini: { requests: 0, errors: 0, totalTokens: 0, totalLatencyMs: 0, avgLatencyMs: 0, lastLatencyMs: 0 },
    openrouter: { requests: 0, errors: 0, totalTokens: 0, totalLatencyMs: 0, avgLatencyMs: 0, lastLatencyMs: 0 },
    qwen: { requests: 0, errors: 0, totalTokens: 0, totalLatencyMs: 0, avgLatencyMs: 0, lastLatencyMs: 0 },
    openai: { requests: 0, errors: 0, totalTokens: 0, totalLatencyMs: 0, avgLatencyMs: 0, lastLatencyMs: 0 },
  }
};

let persistenceSink = null;

export function setMetricsPersistenceSink(sink) {
  persistenceSink = typeof sink === 'function' ? sink : null;
}

export function recordAICall({
  requestId = null,
  provider = 'desconhecido',
  model = '',
  latencyMs = 0,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  intent = 'outro',
  success = true,
  error = null
}) {
  const safeLatency = Math.max(0, Math.round(latencyMs));
  const safePrompt = Math.max(0, Math.round(promptTokens));
  const safeCompletion = Math.max(0, Math.round(completionTokens));
  const safeTotal = safeTotalTokens(safePrompt, safeCompletion, totalTokens);

  state.totalRequests++;
  if (success) {
    state.successfulRequests++;
  } else {
    state.failedRequests++;
  }

  state.totalPromptTokens += safePrompt;
  state.totalCompletionTokens += safeCompletion;
  state.totalTokens += safeTotal;

  state.latencies.push(safeLatency);
  if (state.latencies.length > MAX_HISTORY) state.latencies.shift();

  if (!state.byProvider[provider]) {
    state.byProvider[provider] = { requests: 0, errors: 0, totalTokens: 0, totalLatencyMs: 0, avgLatencyMs: 0, lastLatencyMs: 0 };
  }
  const p = state.byProvider[provider];
  p.requests++;
  if (!success) p.errors++;
  p.totalTokens += safeTotal;
  p.totalLatencyMs += safeLatency;
  p.lastLatencyMs = safeLatency;
  p.avgLatencyMs = Math.round(p.totalLatencyMs / p.requests);

  const entry = {
    id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    provider,
    model: String(model || '').replace(/[<>"']/g, ''),
    latencyMs: safeLatency,
    promptTokens: safePrompt,
    completionTokens: safeCompletion,
    totalTokens: safeTotal,
    intent: String(intent || 'outro').slice(0, 30),
    success: Boolean(success),
    error: error ? sanitizeErrorMessage(error) : null
  };

  state.history.unshift(entry);
  if (state.history.length > MAX_HISTORY) state.history.pop();

  if (!success && error) {
    state.errors.unshift({
      id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      provider,
      model: String(model || ''),
      message: sanitizeErrorMessage(error)
    });
    if (state.errors.length > MAX_ERRORS) state.errors.pop();
  }

  return persistenceSink?.({ requestId, provider, model: entry.model, latencyMs: safeLatency, promptTokens: safePrompt, completionTokens: safeCompletion, totalTokens: safeTotal, intent: entry.intent, success: entry.success, error: entry.error });
}

function safeTotalTokens(prompt, completion, total) {
  if (total && total > 0) return Math.round(total);
  return prompt + completion;
}

function sanitizeErrorMessage(msg) {
  if (typeof msg !== 'string') return 'Erro desconhecido';
  // Remove eventuais dados de cliente ou números longos
  return msg
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\b\d{8,15}\b/g, '[NUMERO]')
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]+/gi, '$1[REDACTED]')
    .replace(/((?:key|api[_-]?key|token|secret)=)[^\s&]+/gi, '$1[REDACTED]')
    .slice(0, 160);
}

export function getMetricsSummary(circuitStatus = {}) {
  const l = state.latencies;
  const avgLatency = l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : 0;
  const sorted = [...l].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
  const p50 = sorted.length ? sorted[Math.floor(sorted.length * 0.50)] : 0;
  const minLatency = sorted.length ? sorted[0] : 0;
  const maxLatency = sorted.length ? sorted[sorted.length - 1] : 0;
  const successRate = state.totalRequests ? Number(((state.successfulRequests / state.totalRequests) * 100).toFixed(1)) : 100;

  return {
    startedAt: state.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    overview: {
      totalRequests: state.totalRequests,
      successfulRequests: state.successfulRequests,
      failedRequests: state.failedRequests,
      successRate,
      avgLatencyMs: avgLatency,
      p50LatencyMs: p50,
      p95LatencyMs: p95,
      minLatencyMs: minLatency,
      maxLatencyMs: maxLatency,
      lastLatencyMs: l.length ? l[l.length - 1] : 0,
      totalPromptTokens: state.totalPromptTokens,
      totalCompletionTokens: state.totalCompletionTokens,
      totalTokens: state.totalTokens,
    },
    byProvider: state.byProvider,
    circuitBreakers: circuitStatus,
    recentCalls: state.history.slice(0, 30),
    recentErrors: state.errors.slice(0, 15)
  };
}

export function resetMetrics() {
  state.totalRequests = 0;
  state.successfulRequests = 0;
  state.failedRequests = 0;
  state.totalPromptTokens = 0;
  state.totalCompletionTokens = 0;
  state.totalTokens = 0;
  state.latencies = [];
  state.history = [];
  state.errors = [];
  for (const k of Object.keys(state.byProvider)) {
    state.byProvider[k] = { requests: 0, errors: 0, totalTokens: 0, totalLatencyMs: 0, avgLatencyMs: 0, lastLatencyMs: 0 };
  }
  return { ok: true };
}
