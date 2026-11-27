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
    await store.claimNext('worker-a', 30);
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
      steps: [{ name: 'gerenciar_cobranca_pagamento', args: { valor: 20, descricao: 'teste' } }],
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
      steps: [{ name: 'gerenciar_cobranca_pagamento', args: { valor: 20, descricao: 'teste' } }],
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


test('reconciliação administrativa registra evidência e não reabre a execução nem a notificação', async () => {
  await withStore(async (store, now, setNow) => {
    const queued = await store.enqueue(input({
      taskKey: 'copilot:uncertain-admin-reconcile',
      retryPolicy: 'never',
      steps: [{ name: 'gerenciar_drive_google', args: { acao: 'criar_pasta', nome: 'Relatório' } }]
    }));
    const claimed = await store.claimNext('worker-reconcile', 30);
    assert.equal(claimed.id, queued.id);
    setNow(now() + 31_000);
    assert.equal(await store.claimNext('worker-reconcile-next', 30), null);

    const pending = await store.listUncertain();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'uncertain');

    await assert.rejects(
      () => store.reconcileUncertain(queued.id, { decision: 'confirmed_succeeded', evidence: 'curto', actor: 'admin@example.com' }),
      /reconciliation_evidence_required/
    );
    await assert.rejects(
      () => store.reconcileUncertain(queued.id, { decision: 'notification_confirmed_sent', evidence: 'Conferi o Drive e confirmei a pasta criada.', actor: 'admin@example.com' }),
      /reconciliation_decision_mismatch/
    );

    const reconciled = await store.reconcileUncertain(queued.id, {
      decision: 'confirmed_succeeded',
      evidence: 'Conferi o Drive e confirmei que a pasta foi criada antes da interrupção.',
      actor: 'admin@example.com'
    });
    assert.equal(reconciled.status, 'succeeded');
    assert.equal(reconciled.notificationStatus, 'unaddressable');
    assert.equal(reconciled.reconciliationOutcome, 'confirmed_succeeded');
    assert.equal(reconciled.reconciledBy, 'admin@example.com');
    assert.match(reconciled.reconciliationNote, /Conferi o Drive/);
    assert.ok(reconciled.reconciledAt);
    assert.deepEqual(await store.listUncertain(), []);
    assert.equal(await store.claimPendingNotification(), null);
    assert.equal(await store.claimNext('worker-after-reconcile', 30), null);
    await assert.rejects(
      () => store.reconcileUncertain(queued.id, { decision: 'confirmed_failed', evidence: 'Segunda decisão não pode substituir a primeira.', actor: 'admin@example.com' }),
      /copilot_task_already_reconciled/
    );
  });
});

test('reconciliação de entrega incerta encerra a notificação sem repetir o envio', async () => {
  await withStore(async store => {
    const queued = await store.enqueue(input({ taskKey: 'copilot:uncertain-notification' }));
    const claimed = await store.claimNext('worker-notify', 30);
    assert.equal(claimed.id, queued.id);
    await store.succeed(claimed, { resultText: 'Pesquisa concluída.' });

    const notification = await store.claimPendingNotification();
    assert.equal(notification.id, queued.id);
    assert.equal(await store.finishNotification(notification, 'uncertain', 'whatsapp_delivery_unknown'), true);

    const [uncertain] = await store.listUncertain();
    assert.equal(uncertain.status, 'succeeded');
    assert.equal(uncertain.notificationStatus, 'uncertain');

    const reconciled = await store.reconcileUncertain(queued.id, {
      decision: 'notification_confirmed_not_sent',
      evidence: 'Consultei a conversa do WhatsApp e a mensagem não consta como entregue.',
      actor: 'admin@example.com'
    });
    assert.equal(reconciled.status, 'succeeded');
    assert.equal(reconciled.notificationStatus, 'unaddressable');
    assert.equal(reconciled.reconciliationOutcome, 'notification_confirmed_not_sent');
    assert.deepEqual(await store.listUncertain(), []);
    assert.equal(await store.claimPendingNotification(), null);
  });
});

test('reconciliação pode manter execução incerta sem liberar reprocessamento', async () => {
  await withStore(async (store, now, setNow) => {
    const queued = await store.enqueue(input({
      taskKey: 'copilot:still-uncertain',
      retryPolicy: 'never',
      steps: [{ name: 'gerenciar_drive_google', args: { acao: 'criar_documento', titulo: 'Ata' } }]
    }));
    await store.claimNext('worker-still-uncertain', 30);
    setNow(now() + 31_000);
    await store.claimNext('worker-detect-uncertain', 30);
    const reconciled = await store.reconcileUncertain(queued.id, {
      decision: 'still_uncertain',
      evidence: 'O histórico externo não permite confirmar se a criação ocorreu.',
      actor: 'admin@example.com'
    });
    assert.equal(reconciled.status, 'uncertain');
    assert.equal(reconciled.notificationStatus, 'unaddressable');
    assert.equal(reconciled.reconciliationOutcome, 'still_uncertain');
    assert.equal((await store.listUncertain()).length, 1);
    assert.equal(await store.claimPendingNotification(), null);
    assert.equal(await store.claimNext('worker-must-not-replay', 30), null);

    const resolvedLater = await store.reconcileUncertain(queued.id, {
      decision: 'confirmed_failed',
      evidence: 'Conferi novamente com o histórico do Drive e confirmei que a criação não ocorreu.',
      actor: 'admin@example.com'
    });
    assert.equal(resolvedLater.status, 'failed');
    assert.equal(resolvedLater.notificationStatus, 'unaddressable');
    assert.equal(resolvedLater.reconciliationOutcome, 'confirmed_failed');
    assert.deepEqual(await store.listUncertain(), []);
    assert.equal(await store.claimNext('worker-after-final-decision', 30), null);
  });
});


test('reconciliação Supabase usa CAS incluindo reconciled_at para impedir decisões concorrentes', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const row = {
    id,
    task_key: 'copilot:remote-uncertain',
    owner_key: 'owner_self',
    status: 'uncertain',
    notification_status: 'unaddressable',
    updated_at: '2026-11-22T12:00:00.000Z',
    created_at: '2026-11-22T11:00:00.000Z',
    steps: [{ name: 'gerenciar_drive_google', args: { acao: 'criar_pasta' } }]
  };
  const calls = [];
  const client = {
    enabled: true,
    async select(table, query) {
      assert.equal(table, 'copilot_tasks');
      if (query === 'select=id&limit=1') return [{ id }];
      return [{ ...row }];
    },
    async request(table, options) {
      calls.push({ table, ...options });
      if (options.forceConflict) return [];
      Object.assign(row, {
        status: options.body.status,
        notification_status: options.body.notification_status,
        reconciled_at: options.body.reconciled_at,
        reconciled_by: options.body.reconciled_by,
        reconciliation_outcome: options.body.reconciliation_outcome,
        reconciliation_note: options.body.reconciliation_note,
        updated_at: options.body.updated_at
      });
      return [{ ...row }];
    }
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-copilot-remote-reconcile-'));
  try {
    const store = new CopilotTaskStore({
      client,
      filePath: path.join(dir, 'tasks.json'),
      logger: { warn() {}, error() {} }
    });
    await store.load();
    assert.equal(store.mode, 'supabase');

    const reconciled = await store.reconcileUncertain(id, {
      decision: 'confirmed_succeeded',
      evidence: 'Conferi o Google Drive e confirmei que a pasta existe.',
      actor: 'admin@example.com'
    });
    assert.equal(reconciled.status, 'succeeded');
    assert.equal(calls.length, 1);
    assert.match(calls[0].query, /reconciled_at=is\.null/);
    assert.match(calls[0].query, /status=eq\.uncertain/);
    assert.match(calls[0].query, /notification_status=eq\.unaddressable/);
    assert.equal(calls[0].body.notification_status, 'unaddressable');

    const secondId = '123e4567-e89b-42d3-a456-426614174001';
    const otherClient = {
      ...client,
      async select(table, query) {
        if (query === 'select=id&limit=1') return [{ id: secondId }];
        return [{
          ...row,
          id: secondId,
          status: 'uncertain',
          notification_status: 'unaddressable',
          reconciled_at: null,
          reconciliation_outcome: null
        }];
      },
      async request() { return []; }
    };
    const conflictStore = new CopilotTaskStore({
      client: otherClient,
      filePath: path.join(dir, 'other-tasks.json'),
      logger: { warn() {}, error() {} }
    });
    await conflictStore.load();
    await assert.rejects(
      () => conflictStore.reconcileUncertain(secondId, {
        decision: 'confirmed_failed',
        evidence: 'Verifiquei o sistema externo e a criação não ocorreu.',
        actor: 'admin@example.com'
      }),
      /copilot_task_reconciliation_conflict/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
