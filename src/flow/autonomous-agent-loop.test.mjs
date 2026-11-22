import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createFlow } from '../flow.mjs';
import { SessionStore } from '../sessions.mjs';
import { OWNER_SELF_KEY } from '../core/identity.mjs';
import { createLiaRuntime } from '../runtime/index.mjs';
import { LiaRuntimeStore } from '../runtime/store.mjs';
import { CopilotTaskStore } from '../copilot-tasks.mjs';
import { toolGerenciarTarefasAutonomas } from '../tools/gerenciar_tarefas_autonomas.mjs';

test('Copiloto: promessa vazia ("vou verificar") aciona correção automática, executa a ferramenta e entrega o resultado real no mesmo turno', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-autoloop-'));
  const store = new SessionStore(path.join(dir, 'sessions.json'));
  await store.load();
  let calls = 0;

  try {
    const flow = createFlow({
      store,
      faq: async () => [],
      humanPhone: '5588921694598',
      getHumanPhone: () => '5588921694598',
      isOwnerSender: p => p === OWNER_SELF_KEY,
      ai: {
        askAI: async ({ system }) => {
          calls += 1;
          if (calls === 1) {
            return {
              reply: 'Vou verificar a saúde das APIs agora mesmo, só um instante.',
              intent: 'status',
              tool_calls: []
            };
          }
          if (calls === 2) {
            assert.match(system, /CORREÇÃO_OBRIGATÓRIA_DE_FERRAMENTA/);
            return {
              reply: '',
              intent: 'status',
              tool_calls: [{ name: 'consultar_saude_infra', args: { target: 'geral' } }]
            };
          }
          assert.match(system, /TOOL_RESULTS_JSON/);
          return {
            reply: '✅ Conferi a infraestrutura agora: tudo operacional e sem alertas críticos.',
            intent: 'status',
            tool_calls: []
          };
        }
      }
    });

    const reply = await flow.process({
      phone: OWNER_SELF_KEY,
      text: 'dá uma olhada se as apis estão ok',
      origin: 'owner'
    });

    assert.equal(calls, 3);
    assert.match(reply, /Conferi a infraestrutura agora/i);
    assert.doesNotMatch(reply, /só um instante/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Cliente ReAct multi-etapa: buscar_arquivo -> ler_documento -> resposta completa em 1 único turno', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-react-client-'));
  const store = new SessionStore(path.join(dir, 'sessions.json'));
  await store.load();
  const prevToken = process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
  const prevFetch = globalThis.fetch;
  let aiCallCount = 0;

  try {
    process.env.GOOGLE_DRIVE_ACCESS_TOKEN = 'ya29.test-drive';
    globalThis.fetch = async (url) => {
      const sUrl = String(url);
      if (sUrl.includes('drive/v3/files?')) {
        return new Response(JSON.stringify({
          files: [{ id: 'doc-contrato-1', name: 'Modelo de Contrato', mimeType: 'application/vnd.google-apps.document' }]
        }), { status: 200 });
      }
      if (sUrl.includes('doc-contrato-1?fields=')) {
        return new Response(JSON.stringify({
          id: 'doc-contrato-1',
          name: 'Modelo de Contrato',
          mimeType: 'application/vnd.google-apps.document',
          size: '512'
        }), { status: 200 });
      }
      if (sUrl.includes('doc-contrato-1/export?mimeType=text/plain')) {
        return new Response('CLÁUSULA 3: Sem multa de cancelamento com aviso prévio de 15 dias.', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const flow = createFlow({
      store,
      faq: async () => [],
      getBotConfig: () => ({
        identity: { assistantName: 'Lia', ownerName: 'Tauan', businessName: 'Atualyze' },
        ai: { agentMode: 'super_agente', enableToolCalling: true }
      }),
      ai: {
        askAI: async ({ system }) => {
          aiCallCount += 1;
          if (aiCallCount === 1) {
            return {
              reply: '',
              intent: 'duvida',
              tool_calls: [{ name: 'gerenciar_drive_google', args: { acao: 'buscar_arquivo', busca: 'contrato' } }]
            };
          }
          if (aiCallCount === 2) {
            assert.match(system, /doc-contrato-1/);
            return {
              reply: '',
              intent: 'duvida',
              tool_calls: [{ name: 'gerenciar_drive_google', args: { acao: 'ler_documento', fileId: 'doc-contrato-1' } }]
            };
          }
          assert.match(system, /Sem multa de cancelamento com aviso prévio de 15 dias/);
          return {
            reply: 'Consultei nosso modelo de contrato: na Cláusula 3, não há multa de cancelamento, apenas aviso prévio de 15 dias!',
            intent: 'duvida',
            tool_calls: []
          };
        }
      }
    });

    const reply = await flow.process({
      phone: '5588998340099',
      text: 'O contrato tem multa de cancelamento?',
      origin: 'real'
    });

    assert.equal(aiCallCount, 3);
    assert.match(reply, /Cláusula 3/i);
    assert.match(reply, /15 dias/i);
  } finally {
    if (prevToken === undefined) delete process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
    else process.env.GOOGLE_DRIVE_ACCESS_TOKEN = prevToken;
    globalThis.fetch = prevFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Autonomia agendada: gerenciar_tarefas_autonomas cria verificação e Lia Runtime executa proativamente no horário', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-autonomy-sched-'));
  let nowMs = Date.parse('2026-11-21T20:00:00Z');
  const notifications = [];

  try {
    const taskStore = new CopilotTaskStore({
      filePath: path.join(dir, 'copilot-tasks.json'),
      allowLocalFallback: true,
      now: () => nowMs
    });
    await taskStore.load();

    const runtimeStore = new LiaRuntimeStore({
      filePath: path.join(dir, 'lia-runtime.json'),
      allowLocalFallback: true,
      now: () => nowMs
    });
    const liaRuntime = createLiaRuntime({
      store: runtimeStore,
      taskStore,
      getHumanPhone: () => '5588921694598',
      notifyOwner: async (msg) => notifications.push(msg),
      now: () => nowMs
    });
    await liaRuntime.start();

    // 1. Lia agenda uma verificação de infra para daqui a 10 minutos
    const created = await toolGerenciarTarefasAutonomas.execute({
      acao: 'agendar_verificacao',
      titulo: 'Checar saúde das APIs',
      inMinutes: 10,
      actionTool: 'consultar_saude_infra',
      actionArgs: { target: 'geral' }
    }, { actor: 'owner', liaRuntime, now: () => nowMs });

    assert.equal(created.success, true);
    assert.equal(created.commitment.actionTool, 'consultar_saude_infra');

    // 2. Lia agenda um compromisso de aviso simples para daqui a 5 minutos
    const reminder = await toolGerenciarTarefasAutonomas.execute({
      acao: 'agendar_verificacao',
      titulo: 'Retornar proposta comercial para Carlos',
      assunto: 'Carlos',
      inMinutes: 5
    }, { actor: 'owner', liaRuntime, now: () => nowMs });
    assert.equal(reminder.success, true);

    // 3. Avança 12 minutos e acorda o Runtime -> executa ambos proativamente!
    nowMs += 12 * 60_000;
    const wakeSummary = await liaRuntime.wake({ reason: 'scheduler' });
    assert.equal(wakeSummary.dueCommitments, 2);
    assert.equal(wakeSummary.tasksCreated, 1, 'deve enfileirar consultar_saude_infra em copilot_tasks');
    assert.equal(notifications.length, 1, 'deve notificar proativamente o compromisso sem tool');
    assert.match(notifications[0], /Retornar proposta comercial para Carlos/);

    const pendingAfter = await liaRuntime.commitments.list({ status: 'pending' });
    assert.equal(pendingAfter.length, 0, 'ambos os compromissos devem ficar fulfilled após execução');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
