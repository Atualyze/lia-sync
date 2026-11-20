import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryRetrievalQuery, isExplicitHistoryRecallRequest, lastAssistantAskedForAgendaConfirmation, lastAssistantAskedForPayment, lastAssistantAskedForPaymentAmount, selectActiveClientHistory, selectRelevantConversationContext } from './client-context.mjs';

const stamp = value => new Date(value).toISOString();

test('contexto de cliente: uma pausa longa separa o assunto ativo sem apagar o histórico', () => {
  const history = [
    { role: 'user', content: 'Preciso do Pix', createdAt: stamp('2026-11-18T15:57:26Z') },
    { role: 'assistant', content: 'Qual valor da cobrança?', createdAt: stamp('2026-11-18T15:58:20Z') },
    { role: 'user', content: '10', createdAt: stamp('2026-11-18T15:59:22Z') },
    { role: 'user', content: 'Oi', createdAt: stamp('2026-11-18T21:53:52Z') },
    { role: 'assistant', content: 'Boa tarde! Como posso te ajudar hoje?', createdAt: stamp('2026-11-18T21:53:54Z') },
    { role: 'user', content: 'Como assim?', createdAt: stamp('2026-11-18T21:54:19Z') }
  ];

  const selected = selectActiveClientHistory(history, {
    maxTurns: 24,
    nowMs: Date.parse('2026-11-18T21:54:19Z')
  });

  assert.equal(selected.topicBoundary, true);
  assert.deepEqual(selected.history.map(message => message.content), [
    'Oi',
    'Boa tarde! Como posso te ajudar hoje?',
    'Como assim?'
  ]);
  assert.equal(history.length, 6, 'o histórico persistido permanece íntegro');
  assert.equal(history[0].content, 'Preciso do Pix');
});

test('contexto de cliente: operação pendente mantém continuidade mesmo após pausa longa', () => {
  const history = [
    { role: 'user', content: 'Preciso do Pix', createdAt: stamp('2026-11-18T15:57:26Z') },
    { role: 'assistant', content: 'Qual valor da cobrança?', createdAt: stamp('2026-11-18T15:58:20Z') },
    { role: 'user', content: 'Oi', createdAt: stamp('2026-11-18T21:53:52Z') }
  ];

  const selected = selectActiveClientHistory(history, {
    maxTurns: 24,
    nowMs: Date.parse('2026-11-18T21:53:52Z'),
    preservePendingContext: true
  });

  assert.equal(selected.topicBoundary, false);
  assert.deepEqual(selected.history, history);
});


test('contexto: pergunta sobre a resposta recente não dispara recuperação de conversas antigas', () => {
  assert.equal(isExplicitHistoryRecallRequest('O que houve?'), false);
  assert.equal(isExplicitHistoryRecallRequest('Você já conseguiu confirmar o Pix?'), false);
});

test('contexto: recupera conversa antiga somente quando o cliente pede para retomar o assunto', () => {
  const history = [
    { conversationId: 'old-project', role: 'user', content: 'Quero criar um site para minha oficina de motos', createdAt: stamp('2026-11-10T12:00:00Z') },
    { conversationId: 'old-project', role: 'assistant', content: 'Podemos estruturar o site com domínio, hospedagem e painel de agendamentos', createdAt: stamp('2026-11-10T12:01:00Z') },
    { conversationId: 'old-project', role: 'user', content: 'Também quero acompanhar os serviços da oficina', createdAt: stamp('2026-11-10T12:02:00Z') },
    { conversationId: 'current-pix', role: 'user', content: 'Quero o Pix copia e cola', createdAt: stamp('2026-11-19T16:28:00Z') },
    { conversationId: 'current-pix', role: 'assistant', content: 'Qual é o valor para gerar o código?', createdAt: stamp('2026-11-19T16:28:30Z') },
    { conversationId: 'current-pix', role: 'user', content: '5', createdAt: stamp('2026-11-19T16:28:50Z') },
    { conversationId: 'current-pix', role: 'assistant', content: 'Preciso confirmar esse valor com a equipe', createdAt: stamp('2026-11-19T16:29:00Z') }
  ];

  assert.equal(isExplicitHistoryRecallRequest('Vamos retomar o site da oficina de motos'), true);
  const recalled = selectRelevantConversationContext(history, 'Vamos retomar o site da oficina de motos');

  assert.equal(recalled.matched, true);
  assert.equal(recalled.conversationId, 'old-project');
  assert.ok(recalled.messages.some(message => /painel de agendamentos/i.test(message.content)));
  assert.ok(!recalled.messages.some(message => /Pix copia e cola/i.test(message.content)));
});

test('contexto: pedido genérico para retomar conversa pergunta o assunto em vez de escolher uma memória', () => {
  assert.equal(isExplicitHistoryRecallRequest('Vamos voltar àquela conversa?'), true);
  const recalled = selectRelevantConversationContext([
    { conversationId: 'old-project', role: 'user', content: 'Quero criar um site para minha oficina', createdAt: stamp('2026-11-10T12:00:00Z') }
  ], 'Vamos voltar àquela conversa?');

  assert.equal(recalled.matched, false);
  assert.equal(recalled.reason, 'insufficient_topic');
});

test('memória: consulta usa apenas a mensagem atual e os turnos mais próximos', () => {
  const query = buildMemoryRetrievalQuery('O que houve?', [
    { role: 'user', content: 'Quero o Pix copia e cola' },
    { role: 'assistant', content: 'Qual é o valor para gerar o código?' },
    { role: 'user', content: '5' },
    { role: 'assistant', content: 'Preciso confirmar esse valor com a equipe' }
  ]);

  assert.match(query, /Pix copia e cola/);
  assert.match(query, /O que houve/);
  assert.doesNotMatch(query, /oficina|site da oficina/i);
});


test('continuidade de cobrança: número só responde quando a última pergunta pediu o valor Pix', () => {
  const askedAmount = [
    { role: 'user', content: 'Quero o código copia e cola' },
    { role: 'assistant', content: 'Qual é o valor para eu gerar o código copia e cola?' }
  ];
  const changedTopic = [
    ...askedAmount,
    { role: 'user', content: 'Também queria saber sobre o site da oficina' },
    { role: 'assistant', content: 'Claro, vamos falar do site e do painel de agendamentos.' }
  ];

  assert.equal(lastAssistantAskedForPaymentAmount(askedAmount), true);
  assert.equal(lastAssistantAskedForPaymentAmount(changedTopic), false);
  assert.equal(lastAssistantAskedForPayment(changedTopic), false);
});

test('continuidade de agenda: sim ou não só respondem à última pergunta de confirmação de horário', () => {
  const askedConfirmation = [
    { role: 'assistant', content: 'Encontrei esse horário. Posso confirmar e agendar para você?' }
  ];
  const changedTopic = [
    ...askedConfirmation,
    { role: 'user', content: 'Me explica os serviços do painel' },
    { role: 'assistant', content: 'O painel permite acompanhar os serviços e os agendamentos.' }
  ];

  assert.equal(lastAssistantAskedForAgendaConfirmation(askedConfirmation), true);
  assert.equal(lastAssistantAskedForAgendaConfirmation(changedTopic), false);
});
