import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { createApp } from './server.mjs';
import { SessionStore } from './sessions.mjs';
import { AdminConfigStore } from './admin-config.mjs';
import { createCopilotTaskWorker } from './copilot-task-worker.mjs';
import { CopilotTaskStore } from './copilot-tasks.mjs';
import { handleWebhookRoutes } from './http/webhook.mjs';
import { createFlow } from './flow.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';

test('server: drainPending drena mensagens em debounce e resolve promessas pendentes sem erro', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-drain-'));
  try {
    const store = new SessionStore(path.join(dir, 'sessions.json'));
    const adminConfig = new AdminConfigStore(path.join(dir, 'admin-config.json'));
    const processed = [];
    const flow = {
      isDuplicate: () => false,
      allowRate: () => true,
      shouldWarnRate: () => false,
      process: async job => {
        processed.push(job);
        return null;
      }
    };
    const app = await createApp({ store, adminConfig, flow, dashboardAuth: async () => ({ ok: true, role: 'admin' }) });

    const p1 = app.schedule({ phone: '5511999991111', jid: '5511999991111@s.whatsapp.net', text: 'Olá', keyId: 'm1' });
    const p2 = app.schedule({ phone: '5511999991111', jid: '5511999991111@s.whatsapp.net', text: 'Tudo bem?', keyId: 'm2' });

    await app.drainPending();
    await Promise.all([p1, p2]);

    assert.equal(processed.length, 1);
    assert.equal(processed[0].text, 'Olá\nTudo bem?');
    assert.equal(processed[0].messageId, 'm2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('webhook + server: falha no processamento em debounce registra status failed no ledger', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-webhook-fail-'));
  try {
    const store = new SessionStore(path.join(dir, 'sessions.json'));
    const adminConfig = new AdminConfigStore(path.join(dir, 'admin-config.json'));
    const flow = {
      isDuplicate: () => false,
      allowRate: () => true,
      shouldWarnRate: () => false,
      process: async () => {
        const err = new Error('boom_delivery');
        err.code = 'DELIVERY_FAILED';
        throw err;
      }
    };
    const app = await createApp({ store, adminConfig, flow, dashboardAuth: async () => ({ ok: true, role: 'admin' }) });

    const finished = [];
    const webhookEventStore = {
      async begin() { return { tracked: true, duplicate: false, key: 'k-fail' }; },
      async finish(_tracking, status, code) { finished.push({ status, code }); }
    };
    const payload = {
      event: 'MESSAGES_UPSERT',
      data: {
        key: { id: 'msg-fail-1', remoteJid: '5511999992222@s.whatsapp.net', fromMe: false },
        message: { conversation: 'Teste falha debounce' }
      }
    };
    const req = {
      method: 'POST',
      url: '/webhook/evolution',
      headers: {},
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); }
    };
    const res = { writeHead() {}, end() {} };

    const webhookPromise = handleWebhookRoutes({
      req,
      res,
      u: new URL('http://localhost/webhook/evolution'),
      webhookAuthorize: () => true,
      store,
      f: flow,
      adminConfig,
      getHumanPhone: () => '',
      getCachedInstanceOwner: () => null,
      updateInstanceOwner: async () => {},
      rateMessage: '',
      webhookEventStore,
      schedule: app.schedule
    });

    // Drena o timer de debounce imediatamente para não esperar config.debounceMs
    await new Promise(resolve => setTimeout(resolve, 20));
    await app.drainPending();
    await webhookPromise;

    assert.equal(finished.length, 1);
    assert.equal(finished[0].status, 'failed');
    assert.equal(finished[0].code, 'DELIVERY_FAILED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('copilot-task-worker: emite broadcastBridgeEvent bot_reply ao entregar resultado', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-worker-sse-'));
  try {
    const taskStore = new CopilotTaskStore({
      filePath: path.join(dir, 'tasks.json'),
      logger: { warn() {}, error() {} }
    });
    await taskStore.load();
    await taskStore.enqueue({
      taskKey: 'copilot:sse-test',
      ownerKey: OWNER_SELF_KEY,
      targetPhone: '5588999999999',
      actorLabel: 'responsável',
      requestSummary: 'Consultar dados',
      steps: [{ name: 'consultar_web', args: { query: 'dados' } }],
      retryPolicy: 'read_only'
    });
    const session = { history: [] };
    const broadcasted = [];
    const worker = createCopilotTaskWorker({
      taskStore,
      store: { get: () => session, markDirty() {}, flush: async () => {} },
      ai: { askAI: async () => ({ reply: 'Resultado pronto para o painel.' }) },
      getBotConfig: () => ({}),
      sendText: async () => {},
      broadcastBridgeEvent: (type, data) => { broadcasted.push({ type, data }); },
      getHumanPhone: () => '5588999999999',
      logger: { error() {} },
      execute: async () => ({ success: true, sources: [{ title: 'Fonte', url: 'https://example.com' }] })
    });

    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), true);
    assert.equal(broadcasted.length, 1);
    assert.equal(broadcasted[0].type, 'bot_reply');
    assert.equal(broadcasted[0].data.phone, OWNER_SELF_KEY);
    assert.match(broadcasted[0].data.text, /Resultado pronto/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flow: notify serializa gravação via store.enqueue e preserva até 100 mensagens do histórico interno', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-notify-queue-'));
  try {
    const store = new SessionStore(path.join(dir, 'sessions.json'));
    const ownerSession = store.get(OWNER_SELF_KEY);
    ownerSession.history = Array.from({ length: 80 }, (_, idx) => ({
      role: 'assistant',
      content: `msg-${idx}`
    }));

    const enqueuedKeys = [];
    const originalEnqueue = store.enqueue.bind(store);
    store.enqueue = (key, fn) => {
      enqueuedKeys.push(key);
      return originalEnqueue(key, fn);
    };

    const flow = createFlow({
      store,
      ai: { askAI: async () => ({ reply: 'Transferindo para um humano.', handoff: true, handoff_reason: 'teste' }) },
      whatsapp: { sendText: async () => {} },
      getBotConfig: () => ({}),
      humanPhone: '5588999999999',
      logger: { warn() {}, error() {} }
    });

    await flow.process({
      phone: '5511988887777',
      text: 'Quero falar com um atendente humano agora',
      origin: 'real'
    });

    assert.ok(enqueuedKeys.includes(OWNER_SELF_KEY), 'notify deve serializar mutação em OWNER_SELF_KEY via store.enqueue');
    assert.equal(ownerSession.history.length, 81, 'notify não deve truncar histórico do Copiloto para 30');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
