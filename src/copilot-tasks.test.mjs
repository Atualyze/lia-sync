import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    assert.equal((await store.getById(queued.id, 'owner_self')).id, queued.id);
    assert.equal(await store.getById(queued.id, 'another_owner'), null);

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
  assert.equal(createCopilotTaskKey(args), createCopilotTaskKey({ ...args, steps: [{ name: 'consultar_web', args: { query: 'alterado' } }] }));
  assert.notEqual(createCopilotTaskKey(args), createCopilotTaskKey({ ...args, messageId: 'wamid-456' }));
});


test('plano com cobrança Pix nunca recebe política de repetição somente-leitura', async () => {
  await withStore(async store => {
    const task = await store.enqueue(input({
      taskKey: 'copilot:pix-never-retry',
      steps: [{ name: 'gerar_cobranca_pix', args: { valor: 20, descricao: 'teste' } }],
      retryPolicy: 'read_only'
    }));
    assert.equal(task.retryPolicy, 'never');
    assert.equal(task.maxAttempts, 1);
  });
});


test('fila local corrompida falha fechada sem sobrescrever o arquivo', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-copilot-corrupt-'));
  const filePath = path.join(dir, 'tasks.json');
  try {
    await writeFile(filePath, '{json inválido', 'utf8');
    const store = new CopilotTaskStore({
      filePath,
      logger: { warn() {}, error() {} }
    });
    await store.load();
    assert.equal(store.available, false);
    await assert.rejects(store.enqueue(input()), /copilot_task_local_store_corrupt/);
    assert.equal(await store.claimNext('worker-test'), null);
    assert.equal((await (await import('node:fs/promises')).readFile(filePath, 'utf8')), '{json inválido');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('política de repetição só considera ações Google de leitura como seguras', async () => {
  await withStore(async store => {
    const readSheet = await store.enqueue(input({
      taskKey: 'copilot:sheet-read',
      steps: [{ name: 'consultar_planilha_google', args: { acao: 'buscar_linhas', busca: 'preço' } }],
      retryPolicy: 'read_only'
    }));
    const writeSheet = await store.enqueue(input({
      taskKey: 'copilot:sheet-write',
      steps: [{ name: 'consultar_planilha_google', args: { acao: 'adicionar_linha', valores: ['novo'] } }],
      retryPolicy: 'read_only'
    }));
    assert.equal(readSheet.retryPolicy, 'read_only');
    assert.equal(writeSheet.retryPolicy, 'never');
  });
});


test('Supabase configurado sem migration falha fechado por padrão', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-copilot-remote-unavailable-'));
  try {
    const store = new CopilotTaskStore({
      client: { enabled: true, select: async () => { throw new Error('relation does not exist'); } },
      filePath: path.join(dir, 'tasks.json'),
      logger: { warn() {}, error() {} }
    });
    await store.load();
    assert.equal(store.available, false);
    await assert.rejects(store.enqueue(input()), /copilot_task_queue_unavailable/);
    assert.equal(await store.claimNext('worker-test'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fallback local com Supabase configurado exige opt-in explícito', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-copilot-local-opt-in-'));
  try {
    const store = new CopilotTaskStore({
      client: { enabled: true, select: async () => { throw new Error('relation does not exist'); } },
      filePath: path.join(dir, 'tasks.json'),
      allowLocalFallback: true,
      logger: { warn() {}, error() {} }
    });
    await store.load();
    const queued = await store.enqueue(input({ taskKey: 'copilot:local-opt-in' }));
    assert.equal(queued.status, 'queued');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('não abandona tarefas locais pendentes ao habilitar Supabase', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-copilot-migration-'));
  const filePath = path.join(dir, 'tasks.json');
  try {
    const local = new CopilotTaskStore({ filePath, logger: { warn() {}, error() {} } });
    await local.load();
    await local.enqueue(input({ taskKey: 'copilot:local-pending' }));

    const remote = new CopilotTaskStore({
      client: { enabled: true, select: async () => [] },
      filePath,
      logger: { warn() {}, error() {} }
    });
    await remote.load();
    assert.equal(remote.available, false);
    await assert.rejects(remote.enqueue(input({ taskKey: 'copilot:remote-new' })), /copilot_task_queue_unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
