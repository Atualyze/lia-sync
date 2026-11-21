import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { createApp } from './server.mjs';
import { SessionStore } from './sessions.mjs';
import { AdminConfigStore } from './admin-config.mjs';
import { ApiSettingsStore } from './api-settings.mjs';
import { LiaAutonomyStore, createAutonomyEngine } from './autonomy/index.mjs';
import { SupabaseRestClient } from './supabase-runtime.mjs';

function makeReq(method, url, body = null) {
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload;
    }
  };
}

async function callApp(app, method, url, body = null) {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code) { status = code; },
    end(chunk) { raw = String(chunk || ''); }
  };
  await app(makeReq(method, url, body), res);
  return { status, body: raw ? JSON.parse(raw) : null };
}

test('SupabaseRestClient expõe patch() enviando PATCH com Prefer return=representation', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ id: 'evt-1', status: 'processed' }])
    };
  };
  try {
    const client = new SupabaseRestClient({ url: 'https://demo.supabase.co', key: 'svc-key' });
    const rows = await client.patch('lia_events', 'id=eq.evt-1', { status: 'processed' });
    assert.equal(rows[0].status, 'processed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'PATCH');
    assert.equal(calls[0].init.headers.Prefer, 'return=representation');
    assert.match(calls[0].url, /\/rest\/v1\/lia_events\?id=eq\.evt-1$/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('LiaAutonomyStore persiste políticas, decisões (authorization_decision) e sobrevive a restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-autonomy-store-'));
  const filePath = path.join(dir, 'lia-autonomy.json');
  try {
    const store1 = new LiaAutonomyStore({ filePath, logger: { warn() {}, error() {} } });
    const eng1 = createAutonomyEngine({ store: store1, logger: { warn() {}, error() {} } });
    await eng1.start();

    await eng1.saveOrgPolicy('default', {
      autonomy_level: 'supervised_autonomous',
      allowed_actions: ['follow_up', 'crm_update'],
      daily_limits: { maxActionsPerHour: 45, maxOutboundPerDay: 80 }
    });
    await eng1.decideAndAct({
      why: 'Teste persistência decisão',
      proposedAction: 'analyze',
      expectedOutcome: 'ok',
      execute: async () => ({ confirmed: true })
    });

    // Restart em nova instância
    const store2 = new LiaAutonomyStore({ filePath, logger: { warn() {}, error() {} } });
    const eng2 = createAutonomyEngine({ store: store2, logger: { warn() {}, error() {} } });
    await eng2.start();

    const policy = eng2.getPolicy('default');
    assert.equal(policy.autonomy_level, 'supervised_autonomous');
    assert.deepEqual(policy.allowed_actions, ['follow_up', 'crm_update']);
    assert.equal(policy.daily_limits.maxActionsPerHour, 45);

    const decisions = await eng2.listPersistedDecisions({ tenantId: 'default' });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].authorization_decision, 'internal_autonomy');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ApiSettingsStore aplica hot-reload, mascara segredos (write-only) e restaura .env com __CLEAR__', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-api-settings-'));
  const filePath = path.join(dir, 'api-settings.json');
  try {
    const targetConfig = {
      geminiKey: 'AIzaEnvKeyOriginal12345',
      openrouterBaseUrl: 'https://openrouter.ai/api/v1',
      evolutionUrl: 'https://evo-env.example.com',
      apiV1RateLimitPerMin: 60
    };
    const store = new ApiSettingsStore({ filePath, targetConfig, logger: { warn() {}, error() {} } });
    await store.load();

    const updated = await store.update({
      geminiKey: 'AIzaPanelSecretKey99999',
      evolutionUrl: 'https://evo-panel.example.com/'
    });
    assert.equal(targetConfig.geminiKey, 'AIzaPanelSecretKey99999');
    assert.equal(targetConfig.evolutionUrl, 'https://evo-panel.example.com');

    // Segredo nunca é devolvido em texto claro
    const geminiItem = updated.view.items.find(i => i.key === 'geminiKey');
    assert.equal(geminiItem.value, '');
    assert.equal(geminiItem.source, 'panel');
    assert.equal(geminiItem.configured, true);
    assert.match(geminiItem.masked, /^AIza\*\*\*999$/);

    // Restaurar para .env
    await store.update({ geminiKey: '__CLEAR__' });
    assert.equal(targetConfig.geminiKey, 'AIzaEnvKeyOriginal12345');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Rotas /api/dashboard/runtime/* e /api/dashboard/api-settings respeitam RBAC e persistem estado', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-rt-routes-'));
  try {
    const store = new SessionStore(path.join(dir, 'sessions.json'));
    const adminConfig = new AdminConfigStore(path.join(dir, 'admin-config.json'));
    let currentRole = 'viewer';
    const app = await createApp({
      store,
      adminConfig,
      dashboardAuth: async () => ({ ok: true, role: currentRole, email: `${currentRole}@test.local` })
    });

    // Viewer não acessa overview nem api-settings
    const rViewer = await callApp(app, 'GET', '/api/dashboard/runtime/overview');
    assert.equal(rViewer.status, 403);

    // Operator lê overview mas não pode alterar política nem api-settings
    currentRole = 'operator';
    const rOpGet = await callApp(app, 'GET', '/api/dashboard/runtime/overview');
    assert.equal(rOpGet.status, 200);
    assert.equal(rOpGet.body.readiness.runtime.status, 'ready');

    const rOpPut = await callApp(app, 'PUT', '/api/dashboard/runtime/policy', { autonomy_level: 'passive' });
    assert.equal(rOpPut.status, 403);

    const rOpApi = await callApp(app, 'GET', '/api/dashboard/api-settings');
    assert.equal(rOpApi.status, 403);

    // Admin atualiza política, cria objetivo, cria compromisso, acorda runtime e lê api-settings
    currentRole = 'admin';
    const rPolicy = await callApp(app, 'PUT', '/api/dashboard/runtime/policy', {
      tenant_id: 'default',
      autonomy_level: 'supervised_autonomous',
      allowed_actions: ['follow_up'],
      daily_limits: { maxActionsPerHour: 40, maxOutboundPerDay: 60 }
    });
    assert.equal(rPolicy.status, 200);
    assert.equal(rPolicy.body.policy.autonomy_level, 'supervised_autonomous');

    const rGoal = await callApp(app, 'POST', '/api/dashboard/runtime/goals', {
      title: 'Objetivo via Painel',
      indicator: 'leads',
      priority: 'high'
    });
    assert.equal(rGoal.status, 201);
    assert.equal(rGoal.body.goal.title, 'Objetivo via Painel');

    const rCommit = await callApp(app, 'POST', '/api/dashboard/runtime/commitments', {
      title: 'Retornar cliente',
      subject: '5511999998888',
      dueAt: new Date(Date.now() + 3600_000).toISOString()
    });
    assert.equal(rCommit.status, 201);

    const rWake = await callApp(app, 'POST', '/api/dashboard/runtime/wake', {});
    assert.equal(rWake.status, 200);
    assert.equal(rWake.body.ok, true);

    const rApiGet = await callApp(app, 'GET', '/api/dashboard/api-settings');
    assert.equal(rApiGet.status, 200);
    assert.ok(Array.isArray(rApiGet.body.items));
    assert.ok(rApiGet.body.items.every(i => !i.secret || i.value === ''));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
