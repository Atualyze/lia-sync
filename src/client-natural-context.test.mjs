import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFlow } from './flow.mjs';
import { SessionStore } from './sessions.mjs';
import { normalizeHistory } from './ai/parsing.mjs';

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

test('troca de modelo ou fallback em conversa ativa preserva contexto e remove reapresentação de primeiro contato', async () => {
  let nowMs = Date.parse('2026-11-21T12:00:00Z');
  const { store, file } = await makeStore(nowMs);
  const phone = '5588998340087';
  const aiRequests = [];
  let activeModel = 'gemini-2.5-flash';

  const flow = createFlow({
    store,
    now: () => nowMs,
    faq: async () => [],
    humanPhone: '5588999999999',
    getBotConfig: () => ({
      ...botConfig,
      ai: { ...botConfig.ai, model: activeModel }
    }),
    whatsapp: { sendText: async () => {} },
    ai: {
      askAI: async request => {
        aiRequests.push({ model: activeModel, ...request });
        if (aiRequests.length === 1) {
          return {
            reply: 'Olá! Sou a Lia. Posso te ajudar com a integração do sistema. Qual módulo você quer revisar?',
            context_summary: 'Cliente revisando módulos de integração do sistema',
            conversation_state: {
              objective: 'Revisar integração',
              need: 'Escolher módulo',
              next_step: 'Detalhar módulo escolhido',
              confirmed: ['Integração ativa']
            },
            handoff: false,
            tool_calls: []
          };
        }
        // Simula modelo reserva (Cloudflare/OpenRouter) que tenta se reapresentar como se fosse o primeiro contato
        return {
          reply: 'Olá! Eu sou a Lia, sua assistente virtual! Como posso te ajudar hoje? Sobre o módulo financeiro, ele sincroniza boletos e Pix automaticamente.',
          context_summary: 'Explicando sincronização de boletos e Pix no módulo financeiro',
          handoff: false,
          tool_calls: []
        };
      }
    }
  });

  try {
    const turn1 = await flow.process({ phone, text: 'Oi, quero revisar a integração', origin: 'real' });
    assert.match(turn1, /Qual módulo você quer revisar\?/);

    // Troca o modelo ativo no meio da conversa (simulando troca no painel ou fallback)
    activeModel = '@cf/mistralai/mistral-small-3.1-24b-instruct';
    nowMs += 20_000;
    const turn2 = await flow.process({ phone, text: 'O módulo financeiro', origin: 'real' });

    assert.equal(aiRequests.length, 2);
    assert.match(aiRequests[1].system, /\[CONTINUIDADE_ENTRE_MODELOS_E_TURNOS\]/);
    assert.match(aiRequests[1].system, /Cliente revisando módulos de integração do sistema/);
    assert.match(aiRequests[1].system, /Qual módulo você quer revisar\?/);
    assert.doesNotMatch(turn2, /Eu sou a Lia|Como posso te ajudar hoje\?/i);
    assert.match(turn2, /Sobre o módulo financeiro, ele sincroniza boletos e Pix automaticamente/i);
  } finally {
    await store.flush();
    await fs.rm(file, { force: true });
  }
});

test('cliente: lastBotAt mantém continuidade mesmo quando o histórico ativo contém apenas a mensagem atual', async () => {
  let nowMs = Date.parse('2026-11-23T22:00:00-03:00');
  const { store, file } = await makeStore(nowMs);
  const phone = '5588998340090';
  const session = store.get(phone);
  session.history = [];
  session.lastBotAt = at('2026-11-23T21:59:10-03:00');

  const aiRequests = [];
  const flow = createFlow({
    store,
    now: () => nowMs,
    faq: async () => [],
    humanPhone: '5588999999999',
    getBotConfig: () => botConfig,
    ai: {
      askAI: async request => {
        aiRequests.push(request);
        return {
          reply: 'Oi! Sou a Lia, sua assistente pessoal. Posso ajudar com isso.',
          handoff: false,
          tool_calls: []
        };
      }
    }
  });

  try {
    const reply = await flow.process({ phone, text: 'é a nova contratada?', origin: 'real' });
    assert.equal(aiRequests.length, 1);
    assert.match(aiRequests[0].system, /\[CONTINUIDADE_ENTRE_MODELOS_E_TURNOS\]/);
    assert.doesNotMatch(reply, /Sou a Lia|Como posso te ajudar hoje/i);
  } finally {
    await store.flush();
    await fs.rm(file, { force: true });
  }
});


test('normalizeHistory nunca apaga turno da assistente quando a janela começa com fala da assistente', () => {
  const sliced = normalizeHistory([
    { role: 'assistant', content: 'Qual é o valor da cobrança Pix?' },
    { role: 'user', content: '35 reais' }
  ]);
  assert.equal(sliced.length, 3);
  assert.equal(sliced[0].role, 'user');
  assert.equal(sliced[1].role, 'assistant');
  assert.match(sliced[1].content, /Qual é o valor da cobrança Pix\?/);
  assert.equal(sliced[2].content, '35 reais');
});
