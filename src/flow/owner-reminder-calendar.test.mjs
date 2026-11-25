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

test('chamada direta de criação também é bloqueada para pedido genérico de recado', () => {
  const prepared = prepareOwnerReminderCalendarCall({
    message: 'poderia guardar um recado?',
    toolCalls: [{
      name: 'gerenciar_agenda_google',
      args: {
        action: 'criar_evento',
        date: 'hoje',
        startTime: '14:00',
        summary: 'Recado de Nauat'
      }
    }],
    now: Date.parse('2026-11-25T17:00:00-03:00'),
    timezone: 'America/Fortaleza'
  });

  assert.equal(prepared.state, 'clarification');
  assert.match(prepared.reply, /Qual recado você gostaria que eu guardasse/i);
  assert.equal(prepared.toolCalls.length, 0);
});

test('chamada direta com assunto, data e hora fundamentados é normalizada', () => {
  const prepared = prepareOwnerReminderCalendarCall({
    message: 'Nauat, lembrar de comprar a ração do gato, hoje às 20h',
    toolCalls: [{
      name: 'gerenciar_agenda_google',
      args: {
        action: 'criar_evento',
        date: 'hoje',
        startTime: '20h',
        summary: 'Nauat — comprar a ração do gato'
      }
    }],
    now: Date.parse('2026-11-25T17:00:00-03:00'),
    timezone: 'America/Fortaleza'
  });

  assert.equal(prepared.state, 'ready');
  assert.equal(prepared.toolCalls.length, 1);
  assert.deepEqual(prepared.toolCalls[0], {
    name: 'gerenciar_agenda_google',
    args: {
      action: 'criar_evento',
      date: '2026-11-25',
      startTime: '20:00',
      summary: 'Nauat — comprar a ração do gato'
    }
  });
});

test('horário calculado pela IA não pode divergir do horário que o responsável informou', () => {
  const prepared = prepareOwnerReminderCalendarCall({
    message: 'Nauat, lembrar de comprar a ração do gato, hoje às 20h',
    toolCalls: [{
      name: 'gerenciar_agenda_google',
      args: {
        action: 'criar_evento',
        date: 'hoje',
        startTime: '14:00',
        summary: 'Nauat — comprar a ração do gato'
      }
    }],
    now: Date.parse('2026-11-25T12:00:00-03:00'),
    timezone: 'America/Fortaleza'
  });

  assert.equal(prepared.state, 'clarification');
  assert.equal(prepared.code, 'reminder_time_not_grounded');
  assert.match(prepared.reply, /Você informou 20:00, mas a interpretação veio como 14:00/i);
  assert.equal(prepared.toolCalls.length, 0);
});
