import test from 'node:test';
import assert from 'node:assert/strict';
import { handleOwnerQuickCommands } from './owner-commands.mjs';

function baseArgs(overrides = {}) {
  return {
    norm: 'o que vc agendou pro nauat?',
    strippedCmd: 'o que vc agendou pro nauat?',
    sSelf: {},
    store: { markDirty() {} },
    ai: {},
    reminderStore: { listActive: () => [] },
    logger: {},
    now: () => Date.parse('2026-11-25T15:00:00.000Z'),
    botConfig: { integrations: { googleCalendar: { timezone: 'America/Fortaleza' } } },
    identity: {},
    owner: 'Atualyze',
    assistant: 'Lia',
    ownerLabel: 'Atualyze',
    telemetry: {},
    getWaitingList: () => [],
    findSessionByTarget: () => null,
    executeToolCall: async () => ({ success: true, events: [] }),
    stageGeneratedPdf: async () => '',
    PDF_TYPES: [],
    recordSelfTurn: reply => reply,
    ...overrides
  };
}

test('pergunta "o que agendou para pessoa" consulta Google Calendar por nome', async () => {
  let toolInvocation;
  const reply = await handleOwnerQuickCommands(baseArgs({
    executeToolCall: async (name, args, context) => {
      toolInvocation = { name, args, context };
      return {
        success: true,
        events: [{
          id: 'event-123',
          summary: 'Nauat — comprar ração do gato',
          start: { dateTime: '2026-11-25T23:00:00.000Z' }
        }]
      };
    },
    reminderStore: {
      listActive: () => [{
        text: 'Nauat — comprar ração do gato',
        clientName: 'Nauat',
        dueAt: '2026-11-25T20:00:00-03:00'
      }]
    }
  }));

  assert.equal(toolInvocation.name, 'gerenciar_agenda_google');
  assert.equal(toolInvocation.args.action, 'listar_eventos');
  assert.equal(toolInvocation.args.query, 'nauat');
  assert.equal(toolInvocation.args.date, '2026-11-25');
  assert.match(reply, /Google Agenda/);
  assert.match(reply, /Nauat/);
  assert.match(reply, /Lembretes internos pendentes/);
});

test('falha ao consultar Google Agenda não é apresentada como agenda vazia', async () => {
  const reply = await handleOwnerQuickCommands(baseArgs({
    executeToolCall: async () => ({
      success: false,
      error: 'google_calendar_unavailable',
      message: 'Integração real com Google Calendar não está configurada.'
    })
  }));

  assert.match(reply, /Não consegui consultar a agenda/i);
  assert.match(reply, /Não posso afirmar que não há compromisso/i);
  assert.doesNotMatch(reply, /Não encontrei eventos com esse nome/i);
});
