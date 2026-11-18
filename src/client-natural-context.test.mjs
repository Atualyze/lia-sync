import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFlow } from './flow.mjs';
import { SessionStore } from './sessions.mjs';

const at = value => new Date(value).toISOString();
const botConfig = {
  identity: { assistantName: 'Lia', ownerName: 'Tauan', businessName: 'Atualyze' },
  ai: { agentMode: 'super_agente', enableToolCalling: true, contextTurns: 24 }
};

async function makeStore(nowMs) {
  const file = path.join(os.tmpdir(), `lia-context-${process.pid}-${Date.now()}-${Math.random()}.json`);
  const store = new SessionStore(file, { now: () => nowMs, logger: { error() {} } });
  await store.load();
  return { store, file };
}

const oldPixHistory = () => [
  { role: 'user', content: 'Preciso do Pix', createdAt: at('2026-11-18T15:57:26Z') },
  { role: 'assistant', content: 'Qual valor da cobrança?', createdAt: at('2026-11-18T15:58:20Z') },
  { role: 'user', content: '10', createdAt: at('2026-11-18T15:59:22Z') }
];

test('cliente: “Oi → saudação → Como assim?” preserva só contexto recente e não escala preço inventado', async () => {
  let nowMs = Date.parse('2026-11-18T21:53:52Z');
  const { store, file } = await makeStore(nowMs);
  const phone = '5588998340085';
  const session = store.get(phone);
  session.history = oldPixHistory();
  session.contextSummary = 'RESUMO_ANTIGO_DO_PIX_10';
  session.conversationState = { objective: 'RESUMO_ANTIGO_DO_PIX_10', next_step: 'cobrar' };
  const aiRequests = [];
  const notifications = [];
  let unexpectedActionCalls = 0;
  const flow = createFlow({
    store,
    now: () => nowMs,
    faq: async () => [],
    humanPhone: '5588999999999',
    getBotConfig: () => botConfig,
    whatsapp: { sendText: async (_phone, message) => notifications.push(message) },
    reminderStore: { create: async () => { unexpectedActionCalls += 1; return { success: true }; } },
    ai: {
      askAI: async request => {
        aiRequests.push(request);
        if (aiRequests.length === 1) {
          return {
            reply: 'Boa tarde! Tudo bem por aí? Como posso te ajudar hoje?',
            handoff: false,
            tool_calls: []
          };
        }
        if (aiRequests.length === 2) {
          return {
            reply: 'O valor é R$ 10,00. Vou encaminhar a informação para a equipe.',
            intent: 'falar_com_responsavel',
            handoff: true,
            handoff_reason: 'contexto antigo',
            tool_calls: [{ name: 'agendar_retorno_ou_followup', args: { reason: 'cobrar', when: '2026-11-19T10:00:00-03:00' } }],
            reminder: { text: 'cobrar', dueAt: '2026-11-19T10:00:00-03:00' }
          };
        }
        return {
          reply: 'Desculpa, minha resposta anterior ficou confusa. Eu só quis perguntar como posso ajudar. O que você gostaria de saber?',
          handoff: false,
          tool_calls: []
        };
      }
    }
  });

  try {
    const greeting = await flow.process({ phone, text: 'Oi', origin: 'real' });
    assert.match(greeting, /Como posso te ajudar hoje/);
    assert.match(aiRequests[0].system, /Como é a primeira mensagem/);
    assert.deepEqual(aiRequests[0].history, [], 'a primeira saudação não deve herdar o Pix da sessão antiga');

    nowMs = Date.parse('2026-11-18T21:54:19Z');
    const reply = await flow.process({ phone, text: 'Como assim?', origin: 'real' });

    assert.equal(aiRequests.length, 3, 'resposta bloqueada sem relação com o assunto deve ser revista uma vez');
    assert.deepEqual(aiRequests[1].history.map(message => message.content), [
      'Oi',
      'Boa tarde! Tudo bem por aí? Como posso te ajudar hoje?'
    ]);
    assert.doesNotMatch(aiRequests[1].system, /RESUMO_ANTIGO_DO_PIX_10/);
    assert.match(reply, /minha resposta anterior ficou confusa/i);
    assert.doesNotMatch(reply, /R\$\s*10|encaminh|equipe/i);
    assert.equal(session.human, false, 'não deve ativar atendimento humano por preço inventado fora do assunto');
    assert.equal(session.handoffAt, undefined);
    assert.equal(notifications.length, 0);
    assert.equal(unexpectedActionCalls, 0, 'ações e lembretes da resposta contaminada devem ser descartados');
    assert.equal(session.history.length, 7, 'o histórico permanente continua completo');
    assert.equal(session.history[0].content, 'Preciso do Pix');
  } finally {
    await store.flush();
    await fs.rm(file, { force: true });
  }
});

test('cliente: consulta atual de preço ainda pede validação humana quando o valor não está autorizado', async () => {
  const nowMs = Date.parse('2026-11-18T21:54:19Z');
  const { store, file } = await makeStore(nowMs);
  const notifications = [];
  const flow = createFlow({
    store,
    now: () => nowMs,
    faq: async () => [],
    humanPhone: '5588999999999',
    getBotConfig: () => botConfig,
    whatsapp: { sendText: async (_phone, message) => notifications.push(message) },
    ai: { askAI: async () => ({ reply: 'O plano custa R$ 15,00.', handoff: false, tool_calls: [] }) }
  });

  try {
    const reply = await flow.process({ phone: '5588998340086', text: 'Quanto custa o plano?', origin: 'real' });
    const session = store.get('5588998340086');
    assert.match(reply, /confirmar essa informação com a equipe|solicitei essa verificação/i);
    assert.equal(session.human, true);
    assert.ok(session.handoffReason);
    assert.equal(notifications.length, 1);
  } finally {
    await store.flush();
    await fs.rm(file, { force: true });
  }
});
