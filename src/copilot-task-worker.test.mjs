import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { CopilotTaskStore } from './copilot-tasks.mjs';
import { createCopilotTaskWorker, isBackgroundCopilotTool } from './copilot-task-worker.mjs';

test('worker executa consulta permitida em segundo plano e notifica o resultado', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-copilot-worker-'));
  const session = { history: [] };
  const sent = [];
  try {
    const taskStore = new CopilotTaskStore({
      filePath: path.join(dir, 'tasks.json'),
      logger: { warn() {}, error() {} }
    });
    await taskStore.load();
    await taskStore.enqueue({
      taskKey: 'copilot:worker-test',
      ownerKey: 'owner_self',
      targetPhone: '5588999999999',
      actorLabel: 'responsável',
      requestSummary: 'Pesquisar um assunto',
      steps: [{ name: 'consultar_web', args: { query: 'assunto' } }],
      retryPolicy: 'read_only'
    });
    const worker = createCopilotTaskWorker({
      taskStore,
      store: {
        get: () => session,
        markDirty() {},
        flush: async () => {}
      },
      ai: { askAI: async () => ({ reply: 'Encontrei informações relevantes.' }) },
      getBotConfig: () => ({}),
      sendText: async (target, message) => { sent.push({ target, message }); },
      getHumanPhone: () => '5588999999999',
      logger: { error() {} },
      execute: async name => {
        assert.equal(name, 'consultar_web');
        return { success: true, sources: [{ title: 'Fonte', url: 'https://example.com' }] };
      }
    });

    assert.equal(await worker.runOnce(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target, '5588999999999');
    assert.match(sent[0].message, /informações relevantes/i);
    assert.equal(session.history.length, 1);
    const latest = await taskStore.getLatest('owner_self');
    assert.equal(latest.status, 'succeeded');
    assert.equal(latest.notificationStatus, 'sent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('somente consultas explicitamente permitidas entram no worker', () => {
  assert.equal(isBackgroundCopilotTool('consultar_web'), true);
  assert.equal(isBackgroundCopilotTool('consultar_contato_ou_lead'), true);
  assert.equal(isBackgroundCopilotTool('consultar_planilha_google', { acao: 'buscar_linhas' }), true);
  assert.equal(isBackgroundCopilotTool('consultar_planilha_google', { acao: 'adicionar_linha' }), false);
  assert.equal(isBackgroundCopilotTool('gerenciar_drive_google', { acao: 'buscar_arquivo' }), true);
  assert.equal(isBackgroundCopilotTool('gerenciar_drive_google', { acao: 'enviar_arquivo_whatsapp' }), false);
  assert.equal(isBackgroundCopilotTool('gerenciar_agenda_google', { action: 'listar_eventos' }), true);
  assert.equal(isBackgroundCopilotTool('gerenciar_agenda_google', { action: 'criar_evento' }), false);
  assert.equal(isBackgroundCopilotTool('enviar_mensagem_contato'), false);
  assert.equal(isBackgroundCopilotTool('atualizar_dados_crm'), false);
  assert.equal(isBackgroundCopilotTool('gerar_cobranca_pix'), true);
  assert.equal(isBackgroundCopilotTool('checkout_infinitepay', { acao: 'criar_link' }), false);
  assert.equal(isBackgroundCopilotTool('checkout_infinitepay', { acao: 'verificar_pagamento' }), true);
});


test('worker informa falha terminal e não deixa a tarefa silenciosa', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-copilot-worker-failure-'));
  const sent = [];
  try {
    const taskStore = new CopilotTaskStore({
      filePath: path.join(dir, 'tasks.json'),
      logger: { warn() {}, error() {} }
    });
    await taskStore.load();
    await taskStore.enqueue({
      taskKey: 'copilot:worker-failure',
      ownerKey: 'owner_self',
      targetPhone: '5588999999999',
      requestSummary: 'Pesquisar um assunto',
      steps: [{ name: 'consultar_web', args: { query: 'assunto' } }],
      retryPolicy: 'read_only'
    });
    const worker = createCopilotTaskWorker({
      taskStore,
      store: { get: () => ({ history: [] }), markDirty() {}, flush: async () => {} },
      getBotConfig: () => ({}),
      sendText: async (target, message) => { sent.push({ target, message }); },
      getHumanPhone: () => '5588999999999',
      logger: { error() {} },
      execute: async () => ({ success: false, error: 'source_timeout' })
    });

    assert.equal(await worker.runOnce(), false);
    assert.equal(await worker.runOnce(), true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].message, /não foi concluída/i);
    const latest = await taskStore.getLatest('owner_self');
    assert.equal(latest.status, 'failed');
    assert.equal(latest.notificationStatus, 'sent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
