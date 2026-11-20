import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CopilotTaskStore,
  describeCopilotTaskStatus,
  inferCopilotTaskType,
  isBackgroundCopilotStep,
  isCopilotTaskStatusQuery,
  isUnstartedActionPromise,
  prepareCopilotTaskSteps,
  resolveCopilotPaymentMethodChoice
} from './copilot-tasks.mjs';

test('respostas curtas escolhem o meio de pagamento apenas quando a Lia perguntou a preferência', () => {
  const question = 'Você prefere Pix direto (Copia e Cola / QR Code) ou o checkout InfinitePay (Pix e Cartão)?';
  assert.equal(resolveCopilotPaymentMethodChoice('Direto', question), 'pix');
  assert.equal(resolveCopilotPaymentMethodChoice('Copia e Cola', question), 'pix');
  assert.equal(resolveCopilotPaymentMethodChoice('QR Code', question), 'pix');
  assert.equal(resolveCopilotPaymentMethodChoice('Checkout', question), 'checkout');
  assert.equal(resolveCopilotPaymentMethodChoice('Cartão', question), 'checkout');
  assert.equal(resolveCopilotPaymentMethodChoice('Direto', 'Bom dia!'), null);
  assert.equal(resolveCopilotPaymentMethodChoice('Direto', 'Eu posso gerar Pix direto ou checkout InfinitePay.'), null);
  assert.equal(resolveCopilotPaymentMethodChoice('Direto', 'O Pix direto usa QR Code.'), null);
});

test('detector bloqueia promessa sem ferramenta em formas conjugadas e gerúndio', () => {
  assert.equal(isUnstartedActionPromise('Entendido! Gerando a cobrança Pix com valor livre para você agora.'), true);
  assert.equal(isUnstartedActionPromise('Estou pesquisando a documentação agora.'), true);
  assert.equal(isUnstartedActionPromise('Vou verificar isso em seguida.'), true);
  assert.equal(isUnstartedActionPromise('Resultado da pesquisa: encontrei três fontes.'), false);
  assert.equal(isUnstartedActionPromise('A tarefa foi concluída.'), false);
});

test('perguntas de andamento consultam a tarefa persistida, não reabrem a intenção', () => {
  for (const message of ['Onde está?', 'Estou esperando', 'Cadê a pesquisa?', 'Já terminou a consulta?']) {
    assert.equal(isCopilotTaskStatusQuery(message), true, message);
  }
  assert.equal(isCopilotTaskStatusQuery('Bom dia, tudo bem?'), false);
});

test('apenas consultas seguras e Pix estático sem envio entram no worker', () => {
  assert.equal(isBackgroundCopilotStep({ name: 'consultar_web', args: {} }), true);
  assert.equal(isBackgroundCopilotStep({ name: 'consultar_saude_infra', args: {} }), true);
  assert.equal(isBackgroundCopilotStep({ name: 'gerar_cobranca_pix', args: { valor: 20 } }), true);
  assert.equal(isBackgroundCopilotStep({ name: 'enviar_mensagem_contato', args: {} }), false);
  assert.equal(isBackgroundCopilotStep({ name: 'atualizar_dados_crm', args: {} }), false);
  assert.equal(isBackgroundCopilotStep({
    name: 'gerenciar_agenda_google', args: { action: 'criar_evento' }
  }), false);
  assert.equal(isBackgroundCopilotStep({
    name: 'gerenciar_agenda_google', args: { action: 'consultar_livres' }
  }), true);
  assert.equal(isBackgroundCopilotStep({
    name: 'checkout_infinitepay', args: { acao: 'verificar_pagamento' }
  }), false);
  assert.equal(isBackgroundCopilotStep({
    name: 'checkout_infinitepay', args: { acao: 'verificar_pagamento', orderNsu: 'ORDER-123' }
  }), true);
  assert.equal(isBackgroundCopilotStep({
    name: 'consultar_planilha_google', args: { acao: 'adicionar_linha' }
  }), false);
});

test('Pix em worker usa TXID estável e nunca envia o QR por WhatsApp como efeito colateral', () => {
  const steps = prepareCopilotTaskSteps([
    { name: 'gerar_cobranca_pix', args: { valor: 20, descricao: 'pagamento do pão' } }
  ], 'task-123');
  assert.equal(steps[0].args.enviarWhatsApp, false);
  assert.match(steps[0].args.txid, /^LIA[A-F0-9]{22}$/);
  assert.equal(steps[0].recovery_mode, 'safe');
  assert.equal(steps[0].state, 'pending');
  assert.equal(steps[0].args.txid, prepareCopilotTaskSteps([
    { name: 'gerar_cobranca_pix', args: { valor: 20, descricao: 'pagamento do pão' } }
  ], 'task-123')[0].args.txid);
});

test('fila aplica idempotência por mensagem e recupera conflito depois de resposta perdida', async () => {
  const rows = new Map();
  const client = {
    enabled: true,
    async select(_table, query) {
      const key = decodeURIComponent(query.match(/idempotency_key=eq\.([^&]+)/)?.[1] || '');
      return key && rows.has(key) ? [rows.get(key)] : [];
    },
    async request(_table, { body }) {
      const row = body[0];
      if (rows.has(row.idempotency_key)) return [];
      rows.set(row.idempotency_key, row);
      return [row];
    },
    async rpc() { return null; }
  };
  const store = new CopilotTaskStore(client, { logger: { warn() {} } });
  assert.equal(await store.initialize(), true);

  const steps = [{ name: 'consultar_web', args: { query: 'documentação oficial' } }];
  const first = await store.enqueue({ messageId: 'wa-message-1', requestText: 'Pesquise a documentação', steps });
  const duplicate = await store.enqueue({ messageId: 'wa-message-1', requestText: 'Pesquise a documentação', steps });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.id, duplicate.id);
  assert.equal(rows.size, 1);
});

test('cancelamento durável altera a tarefa por RPC e só retorna sucesso confirmado', async () => {
  const calls = [];
  const store = new CopilotTaskStore({
    enabled: true,
    async select() { return []; },
    async rpc(name, args) {
      calls.push({ name, args });
      return true;
    }
  });
  store.ready = true;
  assert.equal(await store.cancel('task-id'), true);
  assert.deepEqual(calls, [{ name: 'cancel_copilot_task', args: { p_task_id: 'task-id' } }]);
});

test('enqueue reconcilia timeout depois de o Supabase já ter confirmado o INSERT', async () => {
  const rows = new Map();
  let threwAfterCommit = false;
  const client = {
    enabled: true,
    async select(_table, query) {
      const key = decodeURIComponent(query.match(/idempotency_key=eq\.([^&]+)/)?.[1] || '');
      return key && rows.has(key) ? [rows.get(key)] : [];
    },
    async request(_table, { body }) {
      const row = body[0];
      rows.set(row.idempotency_key, row);
      if (!threwAfterCommit) {
        threwAfterCommit = true;
        throw new Error('Supabase POST timeout after commit');
      }
      return [row];
    },
    async rpc() { return null; }
  };
  const store = new CopilotTaskStore(client, { logger: { warn() {} } });
  await store.initialize();
  const result = await store.enqueue({
    messageId: 'wa-message-response-lost',
    requestText: 'Pesquise a documentação oficial',
    steps: [{ name: 'consultar_web', args: { query: 'documentação oficial' } }]
  });
  assert.equal(result.duplicate, true);
  assert.equal(rows.size, 1);
});

test('fila recusa plano com etapas demais ou efeito externo', async () => {
  const store = new CopilotTaskStore({ enabled: true, async select() { return []; } });
  store.ready = true;
  await assert.rejects(() => store.enqueue({
    messageId: 'message',
    steps: [{ name: 'enviar_mensagem_contato', args: {} }]
  }), /not_background_safe/);
  assert.match(describeCopilotTaskStatus({ id: '12345678-abcd', status: 'running', current_step: 1, steps: [{},{}] }), /em execução/);
  assert.equal(inferCopilotTaskType([{ name: 'consultar_web' }]), 'web');
});
