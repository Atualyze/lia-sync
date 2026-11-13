import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { summarizePersistentCalls, OperationsStore } from './operations.mjs';
import { DEFAULT_BOT_CONFIG, clone, validateBotConfig } from './admin-config.mjs';
import { WebhookEventStore } from './webhook-events.mjs';
import { createRouter } from './http/router.mjs';

const uuid = '123e4567-e89b-42d3-a456-426614174000';

test('telemetria calcula tarifa mensal conhecida e não inventa custo quando falta rate', () => {
  const rows = [
    { provider: 'gemini', model: 'gemini-3.8-flash', prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000, latency_ms: 100, success: true, created_at: '2026-11-13T08:00:00Z', intent: 'triagem' },
    { provider: 'openrouter', model: 'test/model', prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, latency_ms: 300, success: false, error_message: 'falha no cliente ana@example.com telefone 5511999999999', created_at: '2026-11-12T08:00:00Z' }
  ];
  const summary = summarizePersistentCalls(rows, {
    pricingRates: [{ provider: 'gemini', model: 'gemini-3.8-flash', inputUsdPerMillion: 2, outputUsdPerMillion: 4 }],
    monthlyBudgets: [{ provider: 'gemini', model: '', amountUsd: 5 }]
  }, new Date('2026-11-13T12:00:00Z'));
  assert.equal(summary.source, 'supabase');
  assert.equal(summary.overview.totalRequests, 2);
  assert.equal(summary.overview.failedRequests, 1);
  assert.equal(summary.estimatedCost.complete, false);
  assert.equal(summary.estimatedCost.totalUsd, null);
  assert.equal(summary.estimatedCost.knownUsd, 4);
  assert.equal(summary.byProviderModel.find(row => row.provider === 'gemini').budgetUsagePercent, 80);
  assert.doesNotMatch(summary.recentErrors[0].message, /ana@example|5511999999999/);
  assert.equal(JSON.stringify(summary).includes('conversation_id'), false);
  const capped = summarizePersistentCalls([rows[0]], { pricingRates: [{ provider: 'gemini', model: 'gemini-3.8-flash', inputUsdPerMillion: 2, outputUsdPerMillion: 4 }] }, new Date('2026-11-13T12:00:00Z'), { truncated: true });
  assert.equal(capped.estimatedCost.complete, false);
  assert.equal(capped.estimatedCost.totalUsd, null);
  assert.match(capped.estimatedCost.note, /limitado a 5.000 chamadas/);
  const failed = summarizePersistentCalls([{ provider: 'gemini', model: 'gemini-3.8-flash', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, latency_ms: 50, success: false, created_at: '2026-11-13T08:00:00Z' }], {
    pricingRates: [{ provider: 'gemini', model: 'gemini-3.8-flash', inputUsdPerMillion: 2, outputUsdPerMillion: 4 }],
    monthlyBudgets: [{ provider: 'gemini', model: 'gemini-3.8-flash', amountUsd: 10 }]
  }, new Date('2026-11-13T12:00:00Z'));
  assert.equal(failed.estimatedCost.complete, false);
  assert.equal(failed.estimatedCost.totalUsd, null);
  assert.equal(failed.estimatedCost.unknownUsageRequests, 1);
  assert.equal(failed.byProviderModel[0].monthlyEstimatedUsd, null);
  assert.equal(failed.byProviderModel[0].budgetUsagePercent, null);
  assert.equal(failed.overview.tokenUsageComplete, false);
});

test('tarifas nulas não são aceitas nem interpretadas como custo zero', () => {
  const config = clone(DEFAULT_BOT_CONFIG);
  config.ai.pricingRates = [{ provider: 'gemini', model: 'gemini-3.8-flash', inputUsdPerMillion: null, outputUsdPerMillion: 0 }];
  assert.ok(validateBotConfig(config).some(error => /Tarifas/.test(error)));
  const metrics = summarizePersistentCalls([{ provider: 'gemini', model: 'gemini-3.8-flash', prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, success: true, created_at: '2026-11-13T08:00:00Z' }], {
    pricingRates: [{ provider: 'gemini', model: 'gemini-3.8-flash', inputUsdPerMillion: null, outputUsdPerMillion: 0 }]
  }, new Date('2026-11-13T12:00:00Z'));
  assert.equal(metrics.estimatedCost.complete, false);
  assert.equal(metrics.estimatedCost.totalUsd, null);
  assert.equal(metrics.estimatedCost.knownUsd, 0);
});

test('OperationsStore persiste somente metadata permitida na auditoria', async () => {
  let written;
  const store = new OperationsStore({ client: { enabled: true, async insert(table, rows) { written = { table, row: rows[0] }; } }, logger: { warn() {} } });
  await store.audit({ actorId: uuid, action: 'profile_updated', entityType: 'profile', entityId: uuid, metadata: { role: 'operator', active: true, phone: '5511999999999', text: 'mensagem do cliente', source: 'dashboard' } });
  assert.equal(written.table, 'audit_log');
  assert.equal(written.row.actor, uuid);
  assert.deepEqual(written.row.metadata, { role: 'operator', active: true, source: 'dashboard' });
});

test('OperationsStore lê uso mensal paginado com LIMIT explícito e falha se o histórico exceder o teto', async () => {
  const queries = [];
  const store = new OperationsStore({ client: {
    enabled: true,
    async select(_table, query) {
      queries.push(query);
      return [{ request_id: uuid, provider: 'gemini', model: 'model-a', prompt_tokens: 10, completion_tokens: 5, success: true, created_at: '2026-11-13T00:00:00Z' }];
    }
  } });
  const rows = await store.listMonthlyCalls('2026-11-01T00:00:00.000Z');
  assert.equal(rows.length, 1);
  assert.match(queries[0], /limit=1000/);
  assert.match(queries[0], /offset=0/);
  assert.match(queries[0], /created_at=gte\./);

  const truncated = new OperationsStore({ client: {
    enabled: true,
    async select() { return Array.from({ length: 1000 }, () => ({ created_at: '2026-11-13T00:00:00Z' })); }
  } });
  await assert.rejects(truncated.listMonthlyCalls('2026-11-01T00:00:00Z'), error => error.code === 'budget_history_truncated');
});

function fakeWebhookClient() {
  const rows = [];
  const keyFrom = query => query.match(/event_key=eq\.([^&]+)/)?.[1];
  return {
    enabled: true,
    rows,
    async select(_table, query) { const key = keyFrom(query); return rows.filter(row => !key || row.event_key === key).map(row => ({ ...row })); },
    async insert(_table, values) {
      const row = values[0];
      if (rows.some(item => item.event_key === row.event_key)) throw new Error('HTTP 409 duplicate key');
      rows.push({ ...row });
    },
    async request(_table, { query, body, prefer }) {
      const key = keyFrom(query);
      const status = query.match(/status=eq\.([^&]+)/)?.[1];
      const attemptCount = query.match(/attempt_count=eq\.(\d+)/)?.[1];
      const cutoff = query.match(/updated_at=lt\.([^&]+)/)?.[1];
      const matched = rows.filter(row => row.event_key === key && (!status || row.status === status) && (!attemptCount || Number(row.attempt_count) === Number(attemptCount)) && (!cutoff || new Date(row.updated_at) < new Date(decodeURIComponent(cutoff))));
      matched.forEach(row => Object.assign(row, body));
      return prefer.includes('representation') ? matched.map(row => ({ ...row })) : null;
    }
  };
}

test('ledger sanitizado deduplica e permite retentativa atômica de falhas', async () => {
  const client = fakeWebhookClient();
  const store = new WebhookEventStore({ client });
  const first = await store.begin({ key: 'instance:MESSAGESUPSERT:external-id', eventType: 'MESSAGESUPSERT 5511999999999 ana@example.com', instance: '5511999999999' });
  assert.equal(first.duplicate, false);
  assert.equal((await store.begin({ key: 'instance:MESSAGESUPSERT:external-id' })).duplicate, true);
  await store.finish(first, 'failed', 'provider_timeout');
  const retry = await store.begin({ key: 'instance:MESSAGESUPSERT:external-id' });
  assert.equal(retry.duplicate, false);
  assert.equal(client.rows[0].attempt_count, 2);
  await store.finish(first, 'processed');
  assert.equal(client.rows[0].status, 'received', 'worker antigo não pode concluir uma tentativa posterior');
  await store.finish(retry, 'processed');
  assert.equal((await store.begin({ key: 'instance:MESSAGESUPSERT:external-id' })).duplicate, true);
  const listing = await store.list();
  assert.equal(listing.events[0].status, 'processed');
  assert.equal(JSON.stringify(listing).includes('external-id'), false);
  assert.equal(JSON.stringify(listing).includes('phone'), false);
  assert.doesNotMatch(JSON.stringify(listing), /5511999999999|ana@example/);
});

function response() {
  return { statusCode: 200, headers: {}, body: '', setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, headers); }, end(body = '') { this.body += body; } };
}
function request(path, method = 'GET', body = undefined) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.url = path;
  req.method = method;
  req.headers = {};
  return req;
}
function makeRouter(role = 'viewer', authOverride = null) {
  const calls = { executions: 0, suppressionRemovals: 0 };
  const campaign = { id: uuid, title: 'Teste', total_recipients: 1, status: 'pending', recipients: [] };
  const router = createRouter({
    store: { sessions: {} }, f: {},
    adminConfig: { active: { tools: {}, webSearch: { enabled: true } }, draft: {}, revision: 2, persistence: 'supabase' },
    auth: authOverride || (async () => ({ ok: true, userId: uuid, role })),
    webhookAuthorize: async () => true,
    runtimeAI: () => ({ provider: 'gemini', model: 'gemini-3.8-flash', fallbackModels: [] }),
    faqFor: async () => [], rateMessage: '', schedule: async () => {}, getHumanPhone: () => '', getCachedInstanceOwner: () => null,
    updateInstanceOwner: async () => {}, proxyToChatwoot: async () => {}, readinessCheck: async () => ({ ok: true, status: 'ready', checks: [] }),
    campaignStore: {
      enabled: true,
      async list() { return []; }, async listSummaries() { return []; }, async listSuppressions() { return []; },
      async execute() { calls.executions++; return campaign; }, async removeSuppression() { calls.suppressionRemovals++; }
    },
    operationsStore: { enabled: true, async audit() {}, async listUsers() { return []; }, async listAudit() { return []; } },
    webhookEventStore: { async list() { return { configured: true, events: [] }; } }
  });
  return { router, calls };
}
async function dispatch(router, req) { const res = response(); await router(req, res); return { ...res, json: JSON.parse(res.body || '{}') }; }

test('permissões por papel protegem campanhas, usuários e alterações de ferramentas', async () => {
  const { router } = makeRouter('viewer');
  assert.equal((await dispatch(router, request('/api/dashboard/session'))).json.role, 'viewer');
  assert.equal((await dispatch(router, request('/api/dashboard/tools'))).statusCode, 200);
  assert.equal((await dispatch(router, request('/api/dashboard/tools'))).json.draft, null);
  assert.equal((await dispatch(router, request('/api/dashboard/tools', 'PATCH', { enabled: {} }))).statusCode, 403);
  assert.equal((await dispatch(router, request('/api/dashboard/campaigns'))).statusCode, 403);
  assert.equal((await dispatch(router, request('/api/dashboard/users'))).statusCode, 403);
});

test('execução exige papel admin e confirmação explícita; bridge segue com auth de máquina', async () => {
  const operator = makeRouter('operator');
  assert.equal((await dispatch(operator.router, request(`/api/dashboard/campaigns/${uuid}/execute`, 'POST', { confirm: true }))).statusCode, 403);
  const admin = makeRouter('admin');
  assert.ok((await dispatch(admin.router, request('/api/dashboard/tools'))).json.draft);
  assert.equal((await dispatch(admin.router, request(`/api/dashboard/campaigns/${uuid}/execute`, 'POST', { confirm: false }))).statusCode, 400);
  assert.equal(admin.calls.executions, 0);
  assert.equal((await dispatch(admin.router, request('/api/dashboard/suppressions', 'DELETE', { phone: '5511999999999' }))).statusCode, 400);
  assert.equal(admin.calls.suppressionRemovals, 0);
  assert.equal((await dispatch(admin.router, request('/api/dashboard/suppressions', 'DELETE', { phone: '5511999999999', confirm: true }))).statusCode, 200);
  assert.equal(admin.calls.suppressionRemovals, 1);
  assert.equal((await dispatch(admin.router, request(`/api/dashboard/campaigns/${uuid}/execute`, 'POST', { confirm: true }))).statusCode, 200);
  assert.equal(admin.calls.executions, 1);
  const bridge = makeRouter('viewer', async () => ({ ok: false, status: 401 }));
  const machineAuthorized = await dispatch(bridge.router, request('/api/bridge/campaigns'));
  assert.equal(machineAuthorized.statusCode, 200, 'bridge usa somente webhookAuthorize e não o guard humano');
});
