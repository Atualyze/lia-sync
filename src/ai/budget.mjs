import crypto from 'node:crypto';

const PROVIDERS = new Set(['gemini', 'openrouter', 'qwen', 'openai']);
const amount = value => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
const roundUsd = value => Math.round(value * 1_000_000_000) / 1_000_000_000;
const monthStart = now => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

function normalizeBudgets(aiConfig = {}) {
  if (aiConfig.monthlyBudgets === undefined || aiConfig.monthlyBudgets === null) return [];
  if (!Array.isArray(aiConfig.monthlyBudgets)) return null;
  const budgets = [];
  for (const item of aiConfig.monthlyBudgets) {
    if (!item || typeof item !== 'object' || !amount(item.amountUsd) || Number(item.amountUsd) <= 0
        || (item.provider !== undefined && typeof item.provider !== 'string')
        || (item.model !== undefined && typeof item.model !== 'string')) return null;
    const budget = { provider: String(item.provider || '').toLowerCase(), model: String(item.model || '').trim(), amountUsd: Number(item.amountUsd) };
    if (budget.provider && !PROVIDERS.has(budget.provider)) return null;
    budgets.push(budget);
  }
  return budgets;
}

function normalizeRates(aiConfig = {}) {
  const rates = new Map();
  for (const item of Array.isArray(aiConfig.pricingRates) ? aiConfig.pricingRates : []) {
    const provider = String(item?.provider || '').toLowerCase();
    const model = String(item?.model || '').trim();
    if (!PROVIDERS.has(provider) || !model || !amount(item.inputUsdPerMillion) || !amount(item.outputUsdPerMillion)) continue;
    rates.set(`${provider}:${model}`, { input: Number(item.inputUsdPerMillion), output: Number(item.outputUsdPerMillion) });
  }
  return rates;
}

function applies(budget, provider, model) {
  return (!budget.provider || budget.provider === provider) && (!budget.model || budget.model === model);
}

function matchesScope(budget, row) {
  const provider = String(row.provider || '').toLowerCase();
  const model = String(row.model || '');
  return (!budget.provider || budget.provider === provider) && (!budget.model || budget.model === model);
}

function isCurrentMonth(row, now) {
  const date = new Date(row.created_at);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === now.getUTCFullYear() && date.getUTCMonth() === now.getUTCMonth();
}

function requestUpperBound({ system = '', userText = '', history = [], maxOutputTokens = 2048 } = {}) {
  const historyChars = (Array.isArray(history) ? history : []).reduce((sum, item) => sum + String(item?.content || '').length, 0);
  const promptChars = String(system).length + String(userText).length + historyChars;
  // Margem de 25% + 128 tokens cobre tokens especiais, instruções, overhead e ferramentas.
  const inputTokens = Math.ceil((promptChars / 4) * 1.25 + 128);
  const outputTokens = Math.max(1, Math.ceil(Number(maxOutputTokens) || 2048));
  return { inputTokens, outputTokens };
}

function callCost(provider, model, inputTokens, outputTokens, rates) {
  const rate = rates.get(`${provider}:${model}`);
  if (!rate) return null;
  return roundUsd((inputTokens * rate.input + outputTokens * rate.output) / 1_000_000);
}

export class AIBudgetGate {
  constructor({ operationsStore, logger = console, now = () => new Date() } = {}) {
    this.operationsStore = operationsStore;
    this.logger = logger;
    this.now = now;
    this.active = new Map();
    this.queue = Promise.resolve();
  }

  acquire(input = {}) {
    const run = this.queue.then(() => this._acquire(input));
    this.queue = run.catch(() => {});
    return run;
  }

  async _acquire({ provider, model, aiConfig = {}, system = '', userText = '', history = [], maxOutputTokens = 2048 } = {}) {
    const current = new Date(this.now());
    const budgets = normalizeBudgets(aiConfig);
    if (!budgets) return { allowed: false, reason: 'budget_config_invalid', requestId: null, commit() {}, markUnknown() {} };
    const relevant = budgets.filter(item => applies(item, provider, model));
    if (!relevant.length) return { allowed: true, requestId: null, commit() {}, markUnknown() {} };

    const deny = reason => ({ allowed: false, reason, requestId: null, commit() {}, markUnknown() {} });
    if (!this.operationsStore) return deny('budget_usage_unavailable');
    const distributed = typeof this.operationsStore.reserveAIBudget === 'function';
    if (!distributed && typeof this.operationsStore.listMonthlyCalls !== 'function') return deny('budget_usage_unavailable');
    const rates = normalizeRates(aiConfig);
    const candidateRate = rates.get(`${provider}:${model}`);
    if (!candidateRate) return deny('budget_rate_missing');

    let rows = [];
    if (!distributed) {
      try { rows = await this.operationsStore.listMonthlyCalls(monthStart(current)); }
      catch (error) {
        this.logger.warn?.(`[ai-budget] Histórico indisponível; chamada bloqueada: ${error.message}`);
        return deny('budget_usage_unavailable');
      }
      if (!Array.isArray(rows)) return deny('budget_usage_invalid');

      const validNonNegative = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) && Number(value) >= 0;
      for (const row of rows) {
        const date = new Date(row?.created_at);
        if (!row || !Number.isFinite(date.getTime()) || typeof row.provider !== 'string' || !row.provider.trim() || typeof row.model !== 'string' || !row.model.trim() || typeof row.success !== 'boolean' || !validNonNegative(row.prompt_tokens) || !validNonNegative(row.completion_tokens)) {
          return deny('budget_usage_invalid');
        }
      }
    }

    const presentRequestIds = new Set(rows.map(row => row.request_id).filter(Boolean).map(String));
    for (const requestId of presentRequestIds) this.active.delete(requestId);
    const active = [...this.active.values()];
    const upper = requestUpperBound({ system, userText, history, maxOutputTokens });
    const reserveUsd = callCost(provider, model, upper.inputTokens, upper.outputTokens, rates);
    if (reserveUsd === null) return deny('budget_rate_missing');

    for (const budget of relevant) {
      let spent = 0;
      if (!distributed) for (const row of rows) {
          if (!isCurrentMonth(row, current) || !matchesScope(budget, row)) continue;
          if (row.success === false) return deny('budget_usage_unknown');
          const rowRate = rates.get(`${String(row.provider || '').toLowerCase()}:${String(row.model || '')}`);
          if (!rowRate) return deny('budget_rate_missing_for_usage');
          const prompt = Math.max(0, Number(row.prompt_tokens) || 0);
          const completion = Math.max(0, Number(row.completion_tokens) || 0);
          spent += (prompt * rowRate.input + completion * rowRate.output) / 1_000_000;
        }
      if (!distributed) for (const item of active) if (matchesScope(budget, item)) spent += item.costUsd;
      const requested = applies(budget, provider, model) ? reserveUsd : 0;
      if (spent + requested > budget.amountUsd) return deny('monthly_budget_exceeded');
    }

    const requestId = crypto.randomUUID();
    const reservation = { requestId, provider, model, costUsd: reserveUsd, inputTokens: upper.inputTokens, outputTokens: upper.outputTokens };
    if (distributed) {
      const rateRows = [...rates.entries()].map(([key, rate]) => {
        const separator = key.indexOf(':');
        return { provider: key.slice(0, separator), model: key.slice(separator + 1), inputUsdPerMillion: rate.input, outputUsdPerMillion: rate.output };
      });
      try {
        const reserved = await this.operationsStore.reserveAIBudget({
          requestId,
          provider,
          model,
          reservedUsd: reserveUsd,
          monthStart: monthStart(current),
          budgets,
          rates: rateRows
        });
        if (reserved !== true) return deny('monthly_budget_exceeded');
      } catch (error) {
        this.logger.warn?.(`[ai-budget] Reserva distribuída indisponível; chamada bloqueada: ${error.message}`);
        try { await this.operationsStore.releaseAIBudget?.(requestId); } catch {}
        return deny('budget_reservation_unavailable');
      }
    }
    this.active.set(requestId, reservation);
    let finalized = false;
    const commit = async (tokens, effective = {}) => {
      if (finalized) return true;
      finalized = true;
      const effectiveProvider = String(effective.provider || provider).toLowerCase();
      const effectiveModel = typeof effective.model === 'string' && effective.model.trim() ? effective.model.trim() : model;
      reservation.provider = effectiveProvider;
      reservation.model = effectiveModel;
      const promptTokens = Math.max(0, Number(tokens?.promptTokens) || reservation.inputTokens);
      const completionTokens = Math.max(0, Number(tokens?.completionTokens) || reservation.outputTokens);
      const actual = callCost(effectiveProvider, effectiveModel, promptTokens, completionTokens, rates);
      reservation.costUsd = actual === null ? reserveUsd : Math.max(reserveUsd, actual);
      let settlementConfirmed = !distributed;
      if (distributed) {
        try {
          const settlement = { provider: effectiveProvider, model: effectiveModel, usageUnknown: actual === null };
          let settled = await this.operationsStore.settleAIBudget(requestId, reservation.costUsd, settlement);
          if (settled !== true) settled = await this.operationsStore.settleAIBudget(requestId, reservation.costUsd, settlement);
          settlementConfirmed = settled === true;
          if (!settlementConfirmed) {
            this.logger.warn?.('[ai-budget] A liquidação não foi confirmada; tentando preservar a reserva como uso desconhecido.');
            try {
              settlementConfirmed = await this.operationsStore.settleAIBudget(requestId, reserveUsd, { provider: effectiveProvider, model: effectiveModel, usageUnknown: true }) === true;
            } catch {}
          }
        } catch (error) {
          this.logger.warn?.(`[ai-budget] Falha ao liquidar reserva; tentando preservar uso desconhecido: ${error.message}`);
          try {
            settlementConfirmed = await this.operationsStore.settleAIBudget(requestId, reserveUsd, { provider: effectiveProvider, model: effectiveModel, usageUnknown: true }) === true;
          } catch {}
        }
        if (!settlementConfirmed) this.logger.warn?.('[ai-budget] Reserva remota não confirmada; a chamada deve permanecer fail-closed.');
      }
      return settlementConfirmed;
    };
    const markUnknown = async (effective = {}) => {
      if (finalized) return true;
      finalized = true;
      reservation.costUsd = reserveUsd;
      const effectiveProvider = String(effective.provider || provider).toLowerCase();
      const effectiveModel = typeof effective.model === 'string' && effective.model.trim() ? effective.model.trim() : model;
      reservation.provider = effectiveProvider;
      reservation.model = effectiveModel;
      if (!distributed) return true;
      try {
        const settled = await this.operationsStore.settleAIBudget(requestId, reserveUsd, { provider: effectiveProvider, model: effectiveModel, usageUnknown: true });
        if (settled === true) return true;
      } catch (error) { this.logger.warn?.(`[ai-budget] Falha ao registrar custo desconhecido: ${error.message}`); }
      this.logger.warn?.('[ai-budget] Custo desconhecido não foi confirmado; a reserva ficará ativa até expirar.');
      return false;
    };
    return { allowed: true, requestId, reservedUsd: reserveUsd, commit, markUnknown };
  }
}

export { callCost, requestUpperBound };
