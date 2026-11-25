import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectClientReminderQuery,
  buildClientReminderQueryReply
} from './client-reminder-query.mjs';

test('classifica consultas naturais de quantidade como contagem', () => {
  for (const phrase of [
    'quantos lembretes tem no meu contato',
    'quantas tarefas agendadas eu tenho?',
    'qual a quantidade de agendamentos?',
    'conte os compromissos'
  ]) {
    assert.equal(detectClientReminderQuery(phrase), 'contar', phrase);
  }
});

test('classifica listas e perguntas abertas sobre o que está agendado', () => {
  for (const phrase of [
    'liste os afendamento',
    'liste os agendamentos',
    'listar lembretes',
    'quais compromissos',
    'o que tem agendado?',
    'o que está agendado?',
    'tem algo marcado?',
    'meus lembretes'
  ]) {
    assert.equal(detectClientReminderQuery(phrase), 'listar', phrase);
  }
});

test('não confunde um pedido para criar lembrete com uma consulta', () => {
  assert.equal(detectClientReminderQuery('Lembrar o Tauan da reunião amanhã às 14h'), null);
  assert.equal(detectClientReminderQuery('Me avise quando chegar a encomenda'), null);
  assert.equal(detectClientReminderQuery('Quero agendar uma reunião amanhã'), null);
});

test('confirmação curta consulta último lembrete apenas após uma resposta anterior de sucesso', () => {
  const history = [
    { role: 'assistant', content: '✅ Lembrete agendado para amanhã às 14h.' }
  ];
  assert.equal(detectClientReminderQuery('poderia me confirmar?', history), 'ultimo');
  assert.equal(detectClientReminderQuery('pode confirmar?', history), 'ultimo');
  assert.equal(detectClientReminderQuery('poderia me confirmar?', []), null);
});

test('formata contagem e lista apenas com dados reais retornados', () => {
  assert.match(buildClientReminderQueryReply({
    query: 'contar', result: { success: true, count: 2 }
  }), /2 lembrete/);
  assert.match(buildClientReminderQueryReply({
    query: 'listar',
    result: {
      success: true,
      count: 1,
      reminders: [{ text: 'Reunião com Tauan', dueAt: '2026-11-26T17:00:00.000Z' }]
    },
    timezone: 'America/Fortaleza'
  }), /Reunião com Tauan/);
  assert.match(buildClientReminderQueryReply({
    query: 'contar', result: { success: false }
  }), /não consegui consultar/i);
});
