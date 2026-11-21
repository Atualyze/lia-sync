import crypto from 'node:crypto';
import { getCustomProviderPricingRates } from './ai/custom-providers.mjs';
import { describeAIError } from './ai/errors.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_SLUG_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const safeNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const validRateAmount = value => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
const roundUsd = value => Math.round(value * 1_000_000) / 1_000_000;

export const isUuid = value => UUID_RE.test(String(value || ''));

export function maskPhone(phone = '') {
  const digits = String(phone).replace(/\D/g, '');
  return digits.length > 4 ? `${digits.slice(0, 2)}••••${digits.slice(-2)}` : '••••';
}

function safeErrorMessage(value = '') {
  return String(value || 'Erro desconhecido')
    .replace(/\b\d{8,15}\b/g, '[NUMERO]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/(?:sk|key|token)[-_]?[a-z0-9._-]{8,}/gi, '[REDACTED]')
    .replace(/bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .slice(0, 160);
}

function safeMetadata(input = {}) {
  const allowed = new Set(['source', 'recipientCount', 'role', 'active', 'status', 'revision', 'reasonCode', 'provider', 'model', 'estimatedUsd', 'attemptCount', 'toolName', 'actorRole', 'actorLabel', 'durationMs', 'planStep']);
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'string') out[key] = safeErrorMessage(value).slice(0, 120);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function priceIndex(config = {}) {
  const index = new Map();
  // Tarifas de provedores customizados entram como base e podem ser sobrescritas por pricingRates
  for (const rate of getCustomProviderPricingRates()) {
    const provider = String(rate?.provider || '').toLowerCase();
    const model = String(rate?.model || '').trim();
    if (!PROVIDER_SLUG_RE.test(provider) || !model || !validRateAmount(rate?.inputUsdPerMillion) || !validRateAmount(rate?.outputUsdPerMillion)) continue;
    index.set(`${provider}:${model}`, { input: Number(rate.inputUsdPerMillion), output: Number(rate.outputUsdPerMillion) });
  }
  for (const rate of Array.isArray(config.pricingRates) ? config.pricingRates : []) {
    const provider = String(rate?.provider || '').toLowerCase();
    const model = String(rate?.model || '').trim();
    if (!PROVIDER_SLUG_RE.test(provider) || !model || !validRateAmount(rate?.inputUsdPerMillion) || !validRateAmount(rate?.outputUsdPerMillion)) continue;
    index.set(`${provider}:${model}`, {
      input: Number(rate.inputUsdPerMillion),
      output: Number(rate.outputUsdPerMillion)
    });
  }
  return index;
}

function resolveModelRate(rates, provider, model) {
  const exact = rates.get(`${provider}:${model}`);
  if (exact) return exact;
  const wildcard = rates.get(`${provider}:*`);
  if (wildcard) return wildcard;
  if (provider === 'openrouter' && (model === 'openrouter/free' || String(model || '').endsWith(':free'))) {
    return { input: 0, output: 0 };
  }
  return null;
}

function budgetList(config = {}) {
  return (Array.isArray(config.monthlyBudgets) ? config.monthlyBudgets : [])
    .filter(item => item && Number.isFinite(Number(item.amountUsd)) && Number(item.amountUsd) > 0)
    .map(item => ({
      provider: String(item.provider || '').toLowerCase(),
      model: String(item.model || '').trim(),
      amountUsd: Number(item.amountUsd)
    }));
}

function isCurrentMonth(timestamp, now) {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === now.getUTCFullYear() && date.getUTCMonth() === now.getUTCMonth();
}

function p95(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
}

export function summarizePersistentCalls(rows = [], aiConfig = {}, nowValue = new Date(), { truncated = false } = {}) {
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const rates = priceIndex(aiConfig);
  const budgets = budgetList(aiConfig);
  const groups = new Map();
  const latencies = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let failures = 0;
  let monthlyKnownUsd = 0;
  let monthlyMissingRates = 0;
  let monthlyUnknownUsageRequests = 0;

  for (const row of rows) {
    const provider = String(row.provider || 'desconhecido').slice(0, 40);
    const model = String(row.model || 'não informado').slice(0, 160);
    const key = `${provider}:${model}`;
    const prompt = Math.max(0, safeNumber(row.prompt_tokens));
    const completion = Math.max(0, safeNumber(row.completion_tokens));
    const total = Math.max(0, safeNumber(row.total_tokens) || prompt + completion);
    const latency = Math.max(0, safeNumber(row.latency_ms));
    const success = row.success !== false;
    const group = groups.get(key) || {
      provider, model, requests: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0,
      totalTokens: 0, totalLatencyMs: 0, lastLatencyMs: 0, monthlyRequests: 0,
      monthlyPromptTokens: 0, monthlyCompletionTokens: 0, monthlyTotalTokens: 0,
      monthlyFailedRequests: 0, monthlyLatencyMs: 0
    };
    group.requests++;
    if (!success) { group.failedRequests++; failures++; }
    if (success) {
      group.promptTokens += prompt;
      group.completionTokens += completion;
      group.totalTokens += total;
      promptTokens += prompt;
      completionTokens += completion;
      totalTokens += total;
    }
    group.totalLatencyMs += latency;
    if (group.lastLatencyMs === 0) group.lastLatencyMs = latency;
    latencies.push(latency);
    if (isCurrentMonth(row.created_at, now)) {
      group.monthlyRequests++;
      group.monthlyLatencyMs += latency;
      if (!success) { group.monthlyFailedRequests++; monthlyUnknownUsageRequests++; }
      else {
        group.monthlyPromptTokens += prompt;
        group.monthlyCompletionTokens += completion;
        group.monthlyTotalTokens += total;
      }
    }
    groups.set(key, group);
  }

  const byProviderModel = [...groups.values()].map(group => {
    const rate = resolveModelRate(rates, group.provider, group.model);
    const knownUsd = rate
      ? roundUsd((group.promptTokens * rate.input + group.completionTokens * rate.output) / 1_000_000)
      : null;
    const knownMonthlyUsd = rate
      ? roundUsd((group.monthlyPromptTokens * rate.input + group.monthlyCompletionTokens * rate.output) / 1_000_000)
      : null;
    const estimatedUsd = rate && group.failedRequests === 0 ? knownUsd : null;
    const monthlyEstimatedUsd = rate && group.monthlyFailedRequests === 0 ? knownMonthlyUsd : null;
    const budget = budgets.find(item => item.provider === group.provider && item.model === group.model)
      || budgets.find(item => item.provider === group.provider && !item.model)
      || budgets.find(item => !item.provider && !item.model)
      || null;
    if (group.monthlyRequests) {
      if (!rate) monthlyMissingRates++;
      else monthlyKnownUsd += knownMonthlyUsd;
    }
    return {
      ...group,
      avgLatencyMs: group.requests ? Math.round(group.totalLatencyMs / group.requests) : 0,
      successRate: group.requests ? Number((((group.requests - group.failedRequests) / group.requests) * 100).toFixed(1)) : 100,
      estimatedUsd,
      monthlyEstimatedUsd,
      tokenUsageComplete: group.failedRequests === 0,
      monthlyTokenUsageComplete: group.monthlyFailedRequests === 0,
      budgetUsd: budget?.amountUsd ?? null,
      budgetUsagePercent: budget && monthlyEstimatedUsd !== null ? Number(((monthlyEstimatedUsd / budget.amountUsd) * 100).toFixed(1)) : null
    };
  }).sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider));

  const totalRequests = rows.length;
  const successfulRequests = totalRequests - failures;
  const costComplete = monthlyMissingRates === 0 && monthlyUnknownUsageRequests === 0 && !truncated;
  const knownMonthlyUsd = roundUsd(monthlyKnownUsd);
  const recentCalls = rows.slice(0, 30).map(row => ({
    timestamp: row.created_at,
    provider: String(row.provider || '').slice(0, 40),
    model: String(row.model || '').slice(0, 160),
    intent: String(row.intent || 'outro').slice(0, 30),
    latencyMs: Math.max(0, safeNumber(row.latency_ms)),
    promptTokens: Math.max(0, safeNumber(row.prompt_tokens)),
    completionTokens: Math.max(0, safeNumber(row.completion_tokens)),
    totalTokens: Math.max(0, safeNumber(row.total_tokens)),
    success: row.success !== false,
    tokenUsageKnown: row.success !== false
  }));
  const recentErrors = rows.filter(row => row.success === false).slice(0, 15).map(row => {
    const prov = String(row.provider || '').slice(0, 40);
    const mod = String(row.model || '').slice(0, 160);
    const rawMsg = safeErrorMessage(row.error_message);
    const diag = describeAIError(prov, rawMsg, mod);
    return {
      timestamp: row.created_at,
      provider: prov,
      model: mod,
      code: diag.code,
      message: rawMsg.startsWith('[') ? rawMsg : `[${diag.code}] ${diag.message}`
    };
  });
  const providerMap = {};
  const byProviderCost = {};
  let monthlySuccessfulRequests = 0;
  for (const item of byProviderModel) {
    const target = providerMap[item.provider] ||= { requests: 0, errors: 0, totalTokens: 0, totalLatencyMs: 0, avgLatencyMs: 0 };
    target.requests += item.requests;
    target.errors += item.failedRequests;
    target.totalTokens += item.totalTokens;
    target.totalLatencyMs += item.totalLatencyMs;
    monthlySuccessfulRequests += Math.max(0, item.monthlyRequests - item.monthlyFailedRequests);
    if (item.monthlyEstimatedUsd !== null) {
      byProviderCost[item.provider] = roundUsd((byProviderCost[item.provider] || 0) + item.monthlyEstimatedUsd);
    }
  }
  for (const value of Object.values(providerMap)) value.avgLatencyMs = value.requests ? Math.round(value.totalLatencyMs / value.requests) : 0;

  const daysElapsed = Math.max(1, now.getUTCDate());
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dailyBurnRateUsd = roundUsd(knownMonthlyUsd / daysElapsed);
  const projectedMonthlyUsd = roundUsd(dailyBurnRateUsd * daysInMonth);
  const avgCostPer1kCallsUsd = monthlySuccessfulRequests > 0
    ? roundUsd((knownMonthlyUsd / monthlySuccessfulRequests) * 1000)
    : 0;

  return {
    source: 'supabase',
    scope: `últimas ${rows.length} chamadas persistidas`,
    overview: {
      totalRequests,
      successfulRequests,
      failedRequests: failures,
      unknownTokenRequests: failures,
      tokenUsageComplete: failures === 0 && !truncated,
      successRate: totalRequests ? Number(((successfulRequests / totalRequests) * 100).toFixed(1)) : 100,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      p95LatencyMs: p95(latencies),
      lastLatencyMs: rows.length ? Math.max(0, safeNumber(rows[0].latency_ms)) : 0,
      totalPromptTokens: promptTokens,
      totalCompletionTokens: completionTokens,
      totalTokens
    },
    byProvider: providerMap,
    byProviderModel,
    estimatedCost: {
      currency: 'USD',
      estimate: true,
      period: 'mês corrente UTC',
      totalUsd: costComplete ? knownMonthlyUsd : null,
      knownUsd: knownMonthlyUsd,
      dailyBurnRateUsd,
      projectedMonthlyUsd,
      avgCostPer1kCallsUsd,
      byProviderCost,
      complete: costComplete,
      missingRateModels: byProviderModel.filter(item => item.monthlyRequests && !resolveModelRate(rates, item.provider, item.model)).map(item => ({ provider: item.provider, model: item.model })),
      unknownUsageRequests: monthlyUnknownUsageRequests,
      unknownUsageModels: byProviderModel.filter(item => item.monthlyFailedRequests > 0).map(item => ({ provider: item.provider, model: item.model, failedRequests: item.monthlyFailedRequests })),
      note: `Estimativa calculada com tarifas versionadas (incluindo provedores customizados e modelos :free = $0); não representa faturamento confirmado pelo provedor. Falhas não têm tokens/custos presumidos; o subtotal conhecido exclui essas chamadas.${truncated ? ' Histórico limitado a 5.000 chamadas; o custo total pode estar subestimado.' : ''}`
    },
    circuitBreakers: {},
    recentCalls,
    recentErrors
  };
}

export class OperationsStore {
  constructor({ client, logger = console } = {}) {
    this.client = client;
    this.logger = logger;
  }

  get enabled() { return Boolean(this.client?.enabled); }

  async audit({ actorId = null, action, entityType = null, entityId = null, metadata = {} } = {}) {
    if (!this.enabled) throw Object.assign(new Error('audit_persistence_unavailable'), { code: 'audit_persistence_unavailable' });
    await this.client.insert('audit_log', [{
      actor: isUuid(actorId) ? actorId : null,
      action: String(action || 'unknown').slice(0, 120),
      entity_type: entityType ? String(entityType).slice(0, 120) : null,
      entity_id: isUuid(entityId) ? entityId : null,
      metadata: safeMetadata(metadata)
    }]);
  }

  async listAudit(limit = 100) {
    if (!this.enabled) throw Object.assign(new Error('audit_persistence_unavailable'), { code: 'audit_persistence_unavailable' });
    const rows = await this.client.select('audit_log', `select=id,actor,action,entity_type,entity_id,metadata,created_at&order=created_at.desc&limit=${Math.min(200, Math.max(1, Number(limit) || 100))}`);
    return (rows || []).map(row => ({
      id: row.id,
      actorId: row.actor || null,
      action: String(row.action || '').slice(0, 120),
      entityType: row.entity_type || null,
      entityId: row.entity_id || null,
      metadata: safeMetadata(row.metadata || {}),
      createdAt: row.created_at
    }));
  }

  async listUsers() {
    if (!this.enabled) throw Object.assign(new Error('user_management_unavailable'), { code: 'user_management_unavailable' });
    const profiles = await this.client.select('profiles', 'select=id,full_name,role,active,created_at,updated_at&order=created_at.desc&limit=200');
    const response = await fetch(`${this.client.url}/auth/v1/admin/users?page=1&per_page=200`, {
      headers: { apikey: this.client.key, Authorization: `Bearer ${this.client.key}` }
    });
    if (!response.ok) throw Object.assign(new Error('user_directory_unavailable'), { code: 'user_directory_unavailable' });
    const body = await response.json();
    const authUsers = Array.isArray(body) ? body : body?.users || [];
    const usersById = new Map(authUsers.map(user => [user.id, user]));
    return (profiles || []).map(profile => {
      const authUser = usersById.get(profile.id);
      return {
        id: profile.id,
        fullName: profile.full_name || '',
        email: String(authUser?.email || '').slice(0, 254),
        role: profile.role,
        active: profile.active === true,
        createdAt: profile.created_at,
        updatedAt: profile.updated_at,
        lastSignInAt: authUser?.last_sign_in_at || null
      };
    });
  }

  async updateProfile({ id, actorId, role, active, fullName } = {}) {
    if (!this.enabled) throw Object.assign(new Error('user_management_unavailable'), { code: 'user_management_unavailable' });
    if (!isUuid(id) || !['admin', 'operator', 'viewer'].includes(role) || typeof active !== 'boolean') {
      throw Object.assign(new Error('invalid_profile'), { code: 'invalid_profile' });
    }
    if (actorId && String(actorId).toLowerCase() === String(id).toLowerCase() && (!active || role !== 'admin')) {
      throw Object.assign(new Error('cannot_change_own_admin_access'), { code: 'cannot_change_own_admin_access' });
    }
    const profiles = await this.client.select('profiles', 'select=id,role,active&order=created_at.asc&limit=500');
    const current = profiles?.find(profile => profile.id === id);
    if (!current) throw Object.assign(new Error('profile_not_found'), { code: 'profile_not_found' });
    if (current.role === 'admin' && current.active && (!active || role !== 'admin')) {
      const otherAdmins = (profiles || []).filter(profile => profile.id !== id && profile.active === true && profile.role === 'admin');
      if (!otherAdmins.length) throw Object.assign(new Error('last_active_admin_required'), { code: 'last_active_admin_required' });
    }
    const body = { role, active, updated_at: new Date().toISOString() };
    if (typeof fullName === 'string') body.full_name = fullName.trim().slice(0, 160) || null;
    const result = await this.client.request('profiles', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(id)}`,
      body,
      prefer: 'return=representation'
    });
    if (!Array.isArray(result) || !result.length) throw Object.assign(new Error('profile_not_updated'), { code: 'profile_not_updated' });
    return result[0];
  }

  async listPersistentCalls(aiConfig = {}) {
    if (!this.enabled) throw Object.assign(new Error('metrics_persistence_unavailable'), { code: 'metrics_persistence_unavailable' });
    const pages = await Promise.all([0, 1, 2, 3, 4].map(offset => this.client.select(
      'ai_calls',
      `select=created_at,provider,model,latency_ms,prompt_tokens,completion_tokens,total_tokens,intent,success,error_message&order=created_at.desc&limit=1000&offset=${offset * 1000}`
    )));
    const rows = pages.flat().slice(0, 5000);
    const truncated = rows.length === 5000;
    const summary = summarizePersistentCalls(rows, aiConfig, new Date(), { truncated });
    summary.truncated = truncated;
    return summary;
  }

  async listMonthlyCalls(monthStart) {
    if (!this.enabled) throw Object.assign(new Error('metrics_persistence_unavailable'), { code: 'metrics_persistence_unavailable' });
    const start = new Date(monthStart);
    if (!Number.isFinite(start.getTime())) throw new Error('invalid_budget_period');
    const rows = [];
    const pageSize = 1000;
    const maxPages = 50;
    for (let page = 0; page < maxPages; page++) {
      const query = `select=request_id,created_at,provider,model,prompt_tokens,completion_tokens,success&created_at=gte.${encodeURIComponent(start.toISOString())}&order=created_at.asc&limit=${pageSize}&offset=${page * pageSize}`;
      const batch = await this.client.select('ai_calls', query);
      if (!Array.isArray(batch)) throw new Error('invalid_metrics_response');
      rows.push(...batch);
      if (batch.length < pageSize) return rows;
    }
    throw Object.assign(new Error('budget_history_truncated'), { code: 'budget_history_truncated' });
  }

  async reserveAIBudget({ requestId, provider, model, reservedUsd, monthStart, budgets, rates } = {}) {
    if (!this.enabled) throw Object.assign(new Error('budget_reservation_unavailable'), { code: 'budget_reservation_unavailable' });
    const result = await this.client.rpc('reserve_ai_budget', {
      p_request_id: requestId,
      p_provider: provider,
      p_model: model,
      p_reserved_usd: reservedUsd,
      p_month_start: monthStart,
      p_budgets: budgets,
      p_rates: rates
    });
    return result === true;
  }

  async settleAIBudget(requestId, actualUsd, { provider, model, usageUnknown = false } = {}) {
    if (!this.enabled) throw Object.assign(new Error('budget_reservation_unavailable'), { code: 'budget_reservation_unavailable' });
    return (await this.client.rpc('settle_ai_budget_effective', {
      p_request_id: requestId,
      p_provider: provider,
      p_model: model,
      p_actual_usd: actualUsd,
      p_usage_unknown: usageUnknown === true
    })) === true;
  }

  async releaseAIBudget(requestId) {
    if (!this.enabled) return false;
    return (await this.client.rpc('release_ai_budget', { p_request_id: requestId })) === true;
  }
}

export function hashEntityId(value = '') {
  const raw = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32).split('');
  raw[12] = '5';
  raw[16] = ((parseInt(raw[16], 16) & 0x3) | 0x8).toString(16);
  const hex = raw.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
