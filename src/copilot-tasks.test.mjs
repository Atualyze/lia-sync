import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { CopilotTaskStore, createCopilotTaskKey } from './copilot-tasks.mjs';

async function withStore(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-copilot-tasks-'));
  try {
    let now = Date.parse('2026-11-20T12:00:00.000Z');
    const store = new CopilotTaskStore({
      filePath: path.join(dir, 'tasks.json'),
      now: () => now,
      logger: { warn() {}, error() {} },
      ...options
    });
    await store.load();
    await run(store, () => now, value => { now = value; }, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const input = (overrides = {}) => ({
  taskKey: 'copilot:test-task',
  ownerKey: 'owner_self',
  targetPhone: '5588999999999',
  requestSummary: 'Pesquisar informações públicas',
  steps: [{ name: 'consultar_web', args: { query: 'teste' } }],
  retryPolicy: 'read_only',
  ...overrides
});

test('fila local persiste, reivindica, conclui e entrega notificação uma única vez', async () => {
  await withStore(async (store, now, setNow, dir) => {
    const queued = await store.enqueue(input());
    assert.equal(queued.created, true);
    const duplicate = await store.enqueue(input());
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.id, queued.id);

    const claimed = await store.claimNext('worker-test', 60);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.attemptCount, 1);
    assert.ok(claimed.leaseToken);

    assert.ok(await store.checkpoint(claimed, { stepIndex: 0, resultSummary: { completed: 1 } }));
    assert.ok(await store.succeed(claimed, { resultText: 'Pesquisa concluída.' }));

    const notification = await store.claimPendingNotification();
    assert.equal(notification.id, queued.id);
    assert.equal(notification.notificationStatus, 'sending');
    assert.equal(await store.claimPendingNotification(), null);
    assert.equal(await store.finishNotification(notification, 'sent'), true);
    assert.equal(await store.claimPendingNotification(), null);

    const reloaded = new CopilotTaskStore({ filePath: path.join(dir, 'tasks.json'), logger: { warn() {}, error() {} } });
    await reloaded.load();
    assert.equal((await reloaded.getLatest('owner_self')).status, 'succeeded');
  });
});

test('lease expirado reprograma somente leitura e torna ação não repetível incerta', async () => {
  await withStore(async (store, getNow, setNow) => {
    const read = await store.enqueue(input({ taskKey: 'copilot:read' }));
    const claimedRead = await store.claimNext('worker-a', 30);
    setNow(getNow() + 31_000);
    const retriedRead = await store.claimNext('worker-b', 30);
    assert.equal(retriedRead.id, read.id);
    assert.equal(retriedRead.attemptCount, 2);
    setNow(getNow() + 31_000);
    assert.equal(await store.claimNext('worker-c', 30), null);
    const exhaustedNotice = await store.claimPendingNotification();
    assert.equal(exhaustedNotice.status, 'failed');
    assert.match(exhaustedNotice.resultText, /limite de tentativas/i);
    await store.finishNotification(exhaustedNotice, 'sent');
    setNow(getNow() + 1000);

    const payment = await store.enqueue(input({
      taskKey: 'copilot:payment',
      steps: [{ name: 'gerar_cobranca_pix', args: { valor: 20, descricao: 'teste' } }],
      retryPolicy: 'never'
    }));
    const claimedPayment = await store.claimNext('worker-a', 30);
    assert.equal(claimedPayment.id, payment.id);
    setNow(getNow() + 31_000);
    const next = await store.claimNext('worker-b', 30);
    assert.equal(next, null);
    const latest = await store.getLatest('owner_self');
    assert.equal(latest.status, 'uncertain');
    assert.equal(latest.errorCode, 'worker_lease_expired');
  });
});

test('chave de tarefa é estável para a mesma mensagem e plano', () => {
  const args = { messageId: 'wamid-123', ownerKey: 'owner_self', steps: [{ name: 'consultar_web', args: { query: 'x' } }] };
  assert.equal(createCopilotTaskKey(args), createCopilotTaskKey(args));
  assert.notEqual(createCopilotTaskKey(args), createCopilotTaskKey({ ...args, messageId: 'wamid-456' }));
});
