import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { SessionStore } from './sessions.mjs';
import { CopilotTaskStore } from './copilot-tasks.mjs';
import { createCopilotTaskWorker } from './copilot-task-worker.mjs';
import { createFlow } from './flow.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';

test('sessions: claimOutboundDispatch expira claims antigos por TTL e limita crescimento em memória', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-claims-ttl-'));
  try {
    let clock = 1_700_000_000_000;
    const store = new SessionStore(path.join(dir, 'sessions.json'), { now: () => clock });
    assert.equal(await store.claimOutboundDispatch('AABBCCDD', 1000), true);
    assert.equal(await store.claimOutboundDispatch('AABBCCDD', 1000), false);

    clock += 1500;
    assert.equal(await store.claimOutboundDispatch('AABBCCDD', 1000), true);
    assert.equal(store.outboundDispatchClaims.size, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sessions: archive não dispara varredura O(N) de purgeArchives a cada arquivamento', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-archive-no-purge-'));
  try {
    const store = new SessionStore(path.join(dir, 'sessions.json'));
    let purgeCalls = 0;
    store.purgeArchives = async () => { purgeCalls += 1; return 0; };
    store.get('5511999993333');
    await store.archive('5511999993333', 'teste');
    assert.equal(purgeCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('copilot-task-worker: drain executa tarefa e entrega notificação sem esperar próximo tick e onEnqueue acorda apenas em criação nova', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-worker-drain-'));
  try {
    const taskStore = new CopilotTaskStore({
      filePath: path.join(dir, 'tasks.json'),
      logger: { warn() {}, error() {} }
    });
    await taskStore.load();

    let enqueueSignals = 0;
    taskStore.setOnEnqueue(() => { enqueueSignals += 1; });

    const sent = [];
    const session = { history: [] };
    const worker = createCopilotTaskWorker({
      taskStore,
      store: { get: () => session, markDirty() {}, flush: async () => {} },
      ai: { askAI: async () => ({ reply: 'Consulta concluída imediatamente.' }) },
      getBotConfig: () => ({}),
      sendText: async (target, message) => { sent.push({ target, message }); },
      broadcastBridgeEvent: () => {},
      getHumanPhone: () => '5588999999999',
      logger: { error() {} },
      execute: async () => ({ success: true, sources: [{ title: 'Fonte', url: 'https://example.com' }] })
    });

    await taskStore.enqueue({
      taskKey: 'copilot:drain-1',
      ownerKey: OWNER_SELF_KEY,
      targetPhone: '5588999999999',
      actorLabel: 'responsável',
      requestSummary: 'Pesquisa rápida',
      steps: [{ name: 'consultar_web', args: { query: 'rapida' } }],
      retryPolicy: 'read_only'
    });
    // Duplicata idempotente não deve acordar o worker novamente
    await taskStore.enqueue({
      taskKey: 'copilot:drain-1',
      ownerKey: OWNER_SELF_KEY,
      targetPhone: '5588999999999',
      actorLabel: 'responsável',
      requestSummary: 'Pesquisa rápida',
      steps: [{ name: 'consultar_web', args: { query: 'rapida' } }],
      retryPolicy: 'read_only'
    });

    assert.equal(enqueueSignals, 1);

    const cycles = await worker.drain({ maxCycles: 5 });
    assert.equal(cycles, 2); // 1 ciclo executa a tarefa, 1 ciclo entrega a notificação imediatamente
    assert.equal(sent.length, 1);
    assert.match(sent[0].message, /Consulta concluída imediatamente/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flow: rate limit e rateWarned expiram entradas antigas sem crescimento ilimitado', () => {
  let clock = 1_700_000_000_000;
  const flow = createFlow({
    store: { sessions: {}, get: () => ({ history: [] }), markDirty() {} },
    ai: {},
    now: () => clock,
    rateLimitMax: 2,
    rateLimitWindowMs: 1000
  });

  // Popula mais de 500 telefones para disparar a limpeza de expirados
  for (let i = 0; i < 550; i++) {
    const phone = `55119${String(10000000 + i)}`;
    assert.equal(flow.allowRate(phone), true);
    assert.equal(flow.shouldWarnRate(phone), true);
    assert.equal(flow.shouldWarnRate(phone), false);
  }

  // Avança além da janela e valida que entradas antigas expiraram e permitem novo alerta
  clock += 2000;
  assert.equal(flow.allowRate('5511910000000'), true);
  assert.equal(flow.shouldWarnRate('5511910000000'), true);
});
