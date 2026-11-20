import assert from 'node:assert/strict';
import test from 'node:test';
import { createCopilotTaskRunner } from './copilot-task-runner.mjs';

function fixture({ task = null, pending = null, sendText = async () => {}, execute = async () => ({ success: true }), ai = {} } = {})
  const calls = { executed: [], checkpoints: [], finished: [], deliveries: [], sends: [] };
  const tasks = { task, pending };
  const session = { history: [] };
  const sessionStore = {
    get() { return session; },
    markDirty() {},
    async flush() {}
  };
  const taskStore = {
    enabled: true,
    async pendingDelivery() {
      const current = tasks.pending;
      if (current && current.delivery_status === 'pending') return current;
      return null;
    },
    async claimNext() {
      const current = tasks.task;
      tasks.task = null;
      return current;
    },
    async renewLease() { return true; },
    async checkpointStep(...args) { calls.checkpoints.push(args); return true; },
    async finish(...args) { calls.finished.push(args); return true; },
    async beginDelivery(id) {
      const found = [tasks.pending, task].find(item => item?.id === id);
      if (!found || found.delivery_status !== 'pending') return false;
      found.delivery_status = 'sending';
      return true;
    },
    async finishDelivery(...args) {
      calls.deliveries.push(args);
      const found = [tasks.pending, task].find(item => item?.id === args[0]);
      if (found) found.delivery_status = args[1];
      return true;
    }
  };
  const runner = createCopilotTaskRunner({
    taskStore,
    sessionStore,
    ai,
    whatsapp: {
      async sendText(phone, text) {
        calls.sends.push({ phone, text });
        return sendText(phone, text);
      }
    },
    getBotConfig: () => ({}),
    getHumanPhone: () => '5588999998888',
    operationsStore: { async audit() {} },
    logger: { error() {}, warn() {} },
    executeToolCallImpl: async (name, args, context) => {
      calls.executed.push({ name, args, context });
      return execute(name, args, context);
    }
  });
  return { runner, calls, taskStore, tasks, session, sessionStore };
}

test('worker executa etapas em ordem, grava checkpoints e entrega somente após sucesso', async () => {
  const task = {
    id: 'task-1',
    lease_token: 'lease-1',
    actor_label: 'Responsável',
    request_text: 'Pesquise e resuma',
    task_type: 'web',
    status: 'running',
    delivery_status: 'pending',
    current_step: 0,
    steps: [
      { index: 1, name: 'consultar_web', args: { query: 'primeira busca' }, state: 'pending' },
      { index: 2, name: 'consultar_web', args: { query: 'segunda busca' }, state: 'pending' }
    ]
  };
  const { runner, calls, session } = fixture({
    task,
    execute: async (_name, args) => ({ success: true, text: 'Resultado ' + args.query })
  });
  assert.equal(await runner.tick(), true);
  assert.deepEqual(calls.executed.map(item => item.args.query), ['primeira busca', 'segunda busca']);
  assert.equal(calls.checkpoints.filter(item => item[3] === 'succeeded').length, 2);
  assert.equal(calls.finished[0][2], 'succeeded');
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.deliveries[0][1], 'sent');
  assert.ok(session.history.some(item => item.taskId === 'task-1'));
  assert.equal(await runner.tick(), false);
  assert.equal(calls.sends.length, 1);
});

test('worker recebe o contexto de runtime usado pelas ferramentas síncronas', async () => {
  const task = {
    id: 'task-context',
    lease_token: 'lease-context',
    actor_label: 'Responsável',
    request_text: 'Consulta simples',
    task_type: 'web',
    status: 'running',
    delivery_status: 'pending',
    current_step: 0,
    steps: [{ index: 1, name: 'consultar_web', args: { query: 'teste' }, state: 'pending' }]
  };
  const { runner, calls, session, sessionStore } = fixture({ task });
  await runner.tick();
  const context = calls.executed[0].context;
  assert.equal(context.store, sessionStore);
  assert.equal(context.session, session);
  assert.equal(context.phone, '__owner_self__');
  assert.equal(context.actor, 'owner');
  assert.equal(context.isOwner, true);
  assert.equal(context.userText, 'Consulta simples');
  assert.ok('reminderStore' in context);
  assert.ok('adminConfig' in context);
});

test('Pix no worker preserva Copia e Cola exato e não pede uma reescrita à IA', async () => {
  const payload = '000201PIX-CODIGO-EXATO-123456789';
  const task = {
    id: 'task-pix',
    lease_token: 'lease-pix',
    actor_label: 'Responsável',
    request_text: 'Cobrar R$ 20,00 pelo pão',
    task_type: 'payment',
    status: 'running',
    delivery_status: 'pending',
    current_step: 0,
    steps: [{ index: 1, name: 'gerar_cobranca_pix', args: { valor: 20, descricao: 'pagamento do pão' }, state: 'pending' }]
  };
  let aiCalls = 0;
  const { runner, calls } = fixture({ task, ai: { async askAI() { aiCalls += 1; return { reply: 'não pode reescrever o Pix' }; } }, execute: async () => ({
    success: true,
    valor: 20,
    favorecido: 'Atualyze',
    pixCopiaECola: payload,
    paymentUrl: 'https://pay.atualyze.com.br/pix?tx=test',
    qrCodeDataUrl: 'data:image/png;base64,SHOULD_NOT_BE_STORED'
  }) });
  // createCopilotTaskRunner fixture deliberately has no AI provider, so
  // exact payload is formatted by the deterministic non-LLM branch.
  await runner.tick();
  assert.equal(aiCalls, 0);
  assert.equal(calls.sends.length, 1);
  assert.ok(calls.sends[0].text.includes(payload));
  assert.ok(calls.sends[0].text.includes('https://pay.atualyze.com.br/pix?tx=test'));
  assert.ok(!calls.sends[0].text.includes('SHOULD_NOT_BE_STORED'));
});

test('worker retoma entrega de resultado já persistido sem executar ferramenta novamente', async () => {
  const pending = {
    id: 'task-done',
    actor_label: 'Responsável',
    request_text: 'consulta concluída',
    task_type: 'web',
    status: 'succeeded',
    delivery_status: 'pending',
    result: { reply: 'Resultado recuperado da fila.' }
  };
  const { runner, calls } = fixture({ pending });
  assert.equal(await runner.tick(), true);
  assert.equal(calls.executed.length, 0);
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.deliveries[0][1], 'sent');
});

test('worker não entrega o resultado quando o lease foi cancelado durante a etapa', async () => {
  const task = {
    id: 'task-cancelled',
    lease_token: 'lease-cancelled',
    actor_label: 'Responsável',
    request_text: 'Pesquise algo',
    task_type: 'web',
    status: 'running',
    delivery_status: 'pending',
    current_step: 0,
    steps: [{ index: 1, name: 'consultar_web', args: { query: 'teste' }, state: 'pending' }]
  };
  const cancelledFixture = fixture({
    task,
    execute: async () => ({ success: true, text: 'não deve ser entregue' })
  });
  let checkpoints = 0;
  cancelledFixture.taskStore.checkpointStep = async (...args) => {
    cancelledFixture.calls.checkpoints.push(args);
    checkpoints += 1;
    return checkpoints === 1;
  };
  cancelledFixture.taskStore.finish = async () => false;
  assert.equal(await cancelledFixture.runner.tick(), true);
  assert.equal(cancelledFixture.calls.executed.length, 1);
  assert.equal(cancelledFixture.calls.sends.length, 0);
  assert.equal(cancelledFixture.calls.finished.length, 0);
});

test('resultado de envio incerto não dispara uma segunda tentativa', async () => {
  const pending = {
    id: 'task-uncertain-delivery',
    actor_label: 'Responsável',
    request_text: 'consulta concluída',
    task_type: 'web',
    status: 'succeeded',
    delivery_status: 'pending',
    result: { reply: 'Resultado já salvo.' }
  };
  const { runner, calls } = fixture({
    pending,
    sendText: async () => { throw Object.assign(new Error('provider_timeout'), { deliveryUnknown: true }); }
  });
  assert.equal(await runner.tick(), true);
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.deliveries[0][1], 'uncertain');
  assert.equal(await runner.tick(), false);
  assert.equal(calls.sends.length, 1);
});
