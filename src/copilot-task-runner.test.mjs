import assert from 'node:assert/strict';
import test from 'node:test';
import { createCopilotTaskRunner } from './copilot-task-runner.mjs';

function fixture({ task = null, pending = null, sendText = async () => {}, execute = async () => ({ success: true }) } = {}) {
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
    ai: {},
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
  return { runner, calls, taskStore, tasks, session };
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
