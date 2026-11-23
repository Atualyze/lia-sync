import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { createApp } from './server.mjs';
import { handleRuntimeDashboardRoutes } from './http/runtime-routes.mjs';
import { requiredRole } from './http/router.mjs';
import { SessionStore } from './sessions.mjs';
import { AdminConfigStore } from './admin-config.mjs';
import { ApiSettingsStore } from './api-settings.mjs';
import { LiaAutonomyStore, createAutonomyEngine } from './autonomy/index.mjs';
import { SupabaseRestClient } from './supabase-runtime.mjs';
import { createLiaBaileysAuthState, BoundedLruCache } from './whatsapp/baileys-auth.mjs';
import { evaluateBaileysMessageGate } from './whatsapp/baileys-provider.mjs';

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

    // Status e seleção do motor WhatsApp Baileys Nativo
    const rBaileysGet = await callApp(app, 'GET', '/api/dashboard/whatsapp/baileys');
    assert.equal(rBaileysGet.status, 200);
    assert.equal(rBaileysGet.body.provider, 'baileys');
    assert.equal(typeof rBaileysGet.body.stats.messagesReceived, 'number');

    const rEngine = await callApp(app, 'POST', '/api/dashboard/whatsapp/baileys/engine', { engine: 'evolution' });
    assert.equal(rEngine.status, 200);
    assert.equal(rEngine.body.activeEngine, 'evolution');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Baileys P0+P1: Message Gate descarta histórico/broadcast/grupos/duplicatas e AuthState enxuto migra multi-file legado com LRU limitado', async () => {
  const seen = new BoundedLruCache({ max: 5, ttlMs: 60_000 });
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  // 1. Rejeita lote de histórico ('append')
  assert.deepEqual(
    evaluateBaileysMessageGate({ key: { id: 'm1', remoteJid: '5588999999999@s.whatsapp.net' }, message: { conversation: 'oi' }, messageTimestamp: nowSec }, { type: 'append', seenCache: seen, nowMs }),
    { allowed: false, reason: 'history_append_ignored' }
  );

  // 2. Rejeita status@broadcast, grupos (@g.us) e canais (@newsletter)
  assert.equal(
    evaluateBaileysMessageGate({ key: { id: 'm2', remoteJid: 'status@broadcast' }, message: { conversation: 'status' }, messageTimestamp: nowSec }, { type: 'notify', seenCache: seen, nowMs }).allowed,
    false
  );
  assert.equal(
    evaluateBaileysMessageGate({ key: { id: 'm3', remoteJid: '120363000@g.us' }, message: { conversation: 'grupo' }, messageTimestamp: nowSec }, { type: 'notify', seenCache: seen, nowMs }).allowed,
    false
  );

  // 3. Rejeita reação vazia e protocolMessage que não seja REVOKE
  assert.equal(
    evaluateBaileysMessageGate({ key: { id: 'm4', remoteJid: '5588999999999@s.whatsapp.net' }, message: { reactionMessage: { text: '👍' } }, messageTimestamp: nowSec }, { type: 'notify', seenCache: seen, nowMs }).allowed,
    false
  );

  // 4. Aceita mensagem direta real e bloqueia retry duplicado em O(1)
  const validMsg = {
    key: { id: 'm5', remoteJid: '5588999999999@s.whatsapp.net' },
    message: { conversation: 'Bom dia' },
    messageTimestamp: nowSec
  };
  assert.equal(evaluateBaileysMessageGate(validMsg, { type: 'notify', seenCache: seen, nowMs }).allowed, true);
  assert.deepEqual(
    evaluateBaileysMessageGate(validMsg, { type: 'notify', seenCache: seen, nowMs }),
    { allowed: false, reason: 'duplicate_frame' }
  );

  // 5. AuthState enxuto: migra pasta legada, mantém lid-mapping em LRU em RAM e persiste apenas auth-snapshot.json
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-baileys-auth-'));
  try {
    const auth = await createLiaBaileysAuthState({ authDir: dir, logger: { log() {}, warn() {} } });
    await auth.state.keys.set({
      session: { '5588999999999:1': { chainKey: 'ok' } },
      'lid-mapping': { '100979580080280_reverse': '5588999999999' },
      tctoken: { '100979580080280@lid': 'tok123' }
    });
    await auth.saveCreds();

    const gotSession = await auth.state.keys.get('session', ['5588999999999:1']);
    const gotLid = await auth.state.keys.get('lid-mapping', ['100979580080280_reverse']);
    assert.deepEqual(gotSession['5588999999999:1'], { chainKey: 'ok' });
    assert.equal(gotLid['100979580080280_reverse'], '5588999999999');

    const stats = auth.getCacheStats();
    assert.equal(stats.persistedSessions, 1);
    assert.equal(stats.ephemeralKeysInRam, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('reconciliação de tarefas incertas é admin-only, auditada e nunca chama o worker', async () => {
  const taskId = '123e4567-e89b-42d3-a456-426614174000';
  const audit = [];
  const calls = [];
  const copilotTaskStore = {
    available: true,
    listUncertain: async () => [{
      id: taskId,
      status: 'uncertain',
      notificationStatus: 'unaddressable',
      requestSummary: 'Criar pasta de relatório',
      resultText: 'Resultado ficou incerto após a interrupção.',
      errorCode: 'worker_lease_expired',
      steps: [{ name: 'gerenciar_drive_google', args: { acao: 'criar_pasta' } }],
      targetPhone: '5588999998888',
      attemptCount: 1,
      updatedAt: '2026-11-22T12:00:00.000Z'
    }],
    reconcileUncertain: async (id, args) => {
      calls.push({ id, args });
      return {
        id,
        status: 'succeeded',
        notificationStatus: 'unaddressable',
        reconciledAt: '2026-11-22T12:10:00.000Z',
        reconciledBy: args.actor,
        reconciliationOutcome: args.decision,
        reconciliationNote: args.evidence
      };
    }
  };
  const operationsStore = {
    enabled: true,
    audit: async entry => { audit.push(entry); }
  };
  assert.equal(requiredRole('/api/dashboard/runtime/uncertain-tasks', 'GET'), 'admin');
  assert.equal(requiredRole('/api/dashboard/runtime/tasks/' + taskId + '/reconcile', 'POST'), 'admin');

  const invoke = async (method, url, body = null) => {
    const req = makeReq(method, url, body);
    let status = 0;
    let raw = '';
    const res = { writeHead(code) { status = code; }, end(chunk) { raw = String(chunk || ''); } };
    await handleRuntimeDashboardRoutes({
      req, res, u: new URL(url, 'http://localhost'),
      authContext: { role: 'admin', userId: '123e4567-e89b-42d3-a456-426614174001', email: 'admin@test.local' },
      copilotTaskStore, operationsStore
    });
    return { status, body: raw ? JSON.parse(raw) : null };
  };

  const list = await invoke('GET', '/api/dashboard/runtime/uncertain-tasks');
  assert.equal(list.status, 200);
  assert.equal(list.body.items[0].steps[0], 'gerenciar_drive_google');
  assert.equal(list.body.items[0].target, '55••••••88');
  assert.equal(typeof list.body.items[0].steps[0], 'string');

  const result = await invoke('POST', '/api/dashboard/runtime/tasks/' + taskId + '/reconcile', {
    decision: 'confirmed_succeeded',
    evidence: 'Conferi no Google Drive e confirmei que a pasta está criada.'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.replayed, false);
  assert.equal(result.body.task.status, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal(audit.length, 2);
  assert.equal(audit[0].action, 'copilot_task_reconciliation_requested');
  assert.equal(audit[1].action, 'copilot_task_reconciled');
  assert.equal(calls[0].args.actor, 'admin@test.local');
  assert.equal(audit[0].actorId, '123e4567-e89b-42d3-a456-426614174001');
  assert.equal(audit[0].metadata.actorLabel, 'admin@test.local');
  assert.equal('claimNext' in copilotTaskStore, false);
  assert.equal('enqueue' in copilotTaskStore, false);
});

test('reconciliação falha fechado quando a persistência de auditoria está indisponível', async () => {
  const taskId = '123e4567-e89b-42d3-a456-426614174000';
  let reconciled = false;
  const req = makeReq('POST', '/api/dashboard/runtime/tasks/' + taskId + '/reconcile', {
    decision: 'confirmed_failed',
    evidence: 'Consultei o sistema externo e confirmei que a ação não ocorreu.'
  });
  let status = 0, raw = '';
  const res = { writeHead(code) { status = code; }, end(chunk) { raw = String(chunk || ''); } };
  await handleRuntimeDashboardRoutes({
    req, res, u: new URL(req.url, 'http://localhost'),
    authContext: { role: 'admin', email: 'admin@test.local' },
    copilotTaskStore: { available: true, reconcileUncertain: async () => { reconciled = true; } },
    operationsStore: { enabled: false }
  });
  assert.equal(status, 503);
  assert.equal(JSON.parse(raw).error, 'audit_persistence_unavailable');
  assert.equal(reconciled, false);
});


test('se auditoria final falhar depois da reconciliação, API informa estado salvo sem induzir replay', async () => {
  const taskId = '123e4567-e89b-42d3-a456-426614174000';
  let auditCalls = 0;
  let reconciled = false;
  const req = makeReq('POST', '/api/dashboard/runtime/tasks/' + taskId + '/reconcile', {
    decision: 'confirmed_succeeded',
    evidence: 'Conferi no Drive e confirmei que a pasta foi criada.'
  });
  let status = 0, raw = '';
  const res = { writeHead(code) { status = code; }, end(chunk) { raw = String(chunk || ''); } };
  await handleRuntimeDashboardRoutes({
    req, res, u: new URL(req.url, 'http://localhost'),
    authContext: { role: 'admin', userId: '123e4567-e89b-42d3-a456-426614174001' },
    copilotTaskStore: {
      available: true,
      reconcileUncertain: async () => {
        reconciled = true;
        return {
          id: taskId,
          status: 'succeeded',
          notificationStatus: 'unaddressable',
          reconciledAt: '2026-11-22T12:10:00.000Z',
          reconciledBy: '123e4567-e89b-42d3-a456-426614174001',
          reconciliationOutcome: 'confirmed_succeeded',
          reconciliationNote: 'Conferi no Drive e confirmei que a pasta foi criada.'
        };
      }
    },
    operationsStore: {
      enabled: true,
      audit: async () => {
        auditCalls += 1;
        if (auditCalls === 2) throw new Error('audit final unavailable');
      }
    }
  });
  assert.equal(reconciled, true);
  assert.equal(status, 200);
  const body = JSON.parse(raw);
  assert.equal(body.replayed, false);
  assert.equal(body.auditFinalized, false);
  assert.equal(body.task.status, 'succeeded');
  assert.equal(auditCalls, 2);
});
