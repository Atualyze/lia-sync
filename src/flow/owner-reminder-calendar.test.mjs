import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareOwnerReminderCalendarCall } from './owner-reminder-calendar.mjs';

test('pedido genérico para guardar recado nunca vira agendamento', () => {
  const prepared = prepareOwnerReminderCalendarCall({
    message: 'poderia guardar um recado?',
    reminder: {
      text: 'Recado de Nauat',
      dueAt: '2026-11-25T14:00:00-03:00'
    },
    toolCalls: [
      { name: 'agendar_retorno_ou_followup', args: { reason: 'Recado de Nauat', when: '2026-11-25T14:00:00-03:00' } },
      { name: 'consultar_contato_ou_lead', args: { phone: '5511999999999' } }
    ],
    now: Date.parse('2026-11-25T17:00:00-03:00'),
    timezone: 'America/Fortaleza'
  });

  assert.equal(prepared.state, 'clarification');
  assert.match(prepared.reply, /Qual recado você gostaria que eu guardasse/i);
  assert.equal(prepared.toolCalls.some(call => ['agendar_retorno_ou_followup', 'gerenciar_agenda_google'].includes(call.name)), false);
  assert.equal(prepared.toolCalls[0].name, 'consultar_contato_ou_lead');
});

test('lembrete explícito do responsável é convertido em criação de evento no Google Calendar', () => {
  const prepared = prepareOwnerReminderCalendarCall({
    message: 'Nauat, lembrar de comprar a ração do gato, hoje às 20h',
    reminder: {
      text: 'Nauat — lembrar de comprar a ração do gato',
      dueAt: '2026-11-25T20:00:00-03:00'
    },
    toolCalls: [
      { name: 'agendar_retorno_ou_followup', args: { reason: 'Nauat — lembrar de comprar a ração do gato', when: '2026-11-25T20:00:00-03:00' } }
    ],
    now: Date.parse('2026-11-25T17:00:00-03:00'),
    timezone: 'America/Fortaleza'
  });

  assert.equal(prepared.state, 'ready');
  assert.equal(prepared.reminder, null);
  assert.deepEqual(prepared.toolCalls, [{
    name: 'gerenciar_agenda_google',
    args: {
      action: 'criar_evento',
      date: '2026-11-25',
      startTime: '20:00',
      summary: 'Nauat — lembrar de comprar a ração do gato'
    }
  }]);
});

test('assunto sem correspondência com a mensagem não é salvo nem agendado', () => {
  const prepared = prepareOwnerReminderCalendarCall({
    message: 'me lembra hoje às 20h',
    reminder: {
      text: 'Comprar ração para o gato',
      dueAt: '2026-11-25T20:00:00-03:00'
    },
    now: Date.parse('2026-11-25T17:00:00-03:00'),
    timezone: 'America/Fortaleza'
  });

  assert.equal(prepared.state, 'clarification');
  assert.match(prepared.reply, /qual assunto/i);
  assert.equal(prepared.toolCalls.length, 0);
});
