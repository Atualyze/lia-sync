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


test('Copiloto conta Google Agenda e lembretes internos separadamente', async () => {
  let invocation;
  const reply = await handleOwnerQuickCommands(baseArgs({
    norm: 'quantos lembretes tenho?',
    strippedCmd: 'quantos lembretes tenho?',
    executeToolCall: async (name, args) => {
      invocation = { name, args };
      return { success: true, events: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }] };
    },
    reminderStore: {
      listActive: () => [{ text: 'Um' }, { text: 'Dois' }]
    }
  }));

  assert.equal(invocation.name, 'gerenciar_agenda_google');
  assert.equal(invocation.args.action, 'listar_eventos');
  assert.match(reply, /Google Agenda:\* 3 evento\(s\)/);
  assert.match(reply, /Lembretes internos:\* 2 pendente\(s\)/);
});

test('Copiloto reconhece pergunta aberta "o que tem agendado?" como listagem', async () => {
  let called = false;
  const reply = await handleOwnerQuickCommands(baseArgs({
    norm: 'o que tem agendado?',
    strippedCmd: 'o que tem agendado?',
    executeToolCall: async () => {
      called = true;
      return { success: true, events: [{ id: 'e1', summary: 'Reunião de planejamento', start: { dateTime: '2026-11-26T17:00:00.000Z' } }] };
    },
    reminderStore: { listActive: () => [] }
  }));
  assert.equal(called, true);
  assert.match(reply, /Reunião de planejamento/);
  assert.match(reply, /Google Agenda/);
});

test('Copiloto reconhece plural e erro de digitação em pedidos de listagem', async () => {
  for (const phrase of ['liste os afendamento', 'liste os agendamentos', 'quais compromissos']) {
    let called = false;
    const reply = await handleOwnerQuickCommands(baseArgs({
      norm: phrase,
      strippedCmd: phrase,
      executeToolCall: async () => {
        called = true;
        return { success: true, events: [] };
      },
      reminderStore: { listActive: () => [] }
    }));
    assert.equal(called, true, phrase);
    assert.match(reply, /Agenda e lembretes pendentes/);
  }
});

test('falha no Google Calendar preserva contagem interna e não inventa contagem da agenda', async () => {
  const reply = await handleOwnerQuickCommands(baseArgs({
    norm: 'quantos agendamentos existem?',
    strippedCmd: 'quantos agendamentos existem?',
    executeToolCall: async () => ({
      success: false,
      error: 'google_calendar_unavailable',
      message: 'Google Agenda indisponível'
    }),
    reminderStore: { listActive: () => [{ text: 'Lembrete interno' }] }
  }));
  assert.match(reply, /não foi possível consultar/i);
  assert.match(reply, /Não vou estimar essa quantidade/i);
  assert.match(reply, /Lembretes internos:\* 1 pendente/);
});


test('Copiloto confirma lembrete consultando Google Agenda e separando registro interno', async () => {
  let invocation;
  const reply = await handleOwnerQuickCommands(baseArgs({
    norm: 'poderia me confirmar?',
    strippedCmd: 'poderia me confirmar?',
    sSelf: {
      history: [
        { role: 'user', content: 'Lembrar o Tauan sobre a reunião com o gato Buchudo, amanhã às 14h' },
        { role: 'assistant', content: 'Lembrete de retorno agendado com sucesso para 26/11/2026 às 14:00 com foco em: "lembrar o Tauan sobre a reunião com o gato Buchudo, amanhã às 14h".' },
        { role: 'user', content: 'poderia me confirmar?' }
      ]
    },
    executeToolCall: async (name, args) => {
      invocation = { name, args };
      return {
        success: true,
        events: [{
          id: 'event-buchudo',
          summary: 'Lembrar o Tauan sobre a reunião com o gato Buchudo',
          start: { dateTime: '2026-11-26T17:00:00.000Z' }
        }]
      };
    },
    reminderStore: {
      listActive: () => [{
        text: 'Lembrar o Tauan sobre a reunião com o gato Buchudo',
        dueAt: '2026-11-26T17:00:00.000Z'
      }]
    }
  }));

  assert.equal(invocation.name, 'gerenciar_agenda_google');
  assert.equal(invocation.args.action, 'listar_eventos');
  assert.match(invocation.args.query, /Tauan|Buchudo/i);
  assert.match(reply, /Confirmação do agendamento/);
  assert.match(reply, /Google Agenda/);
  assert.match(reply, /Lembretes internos/);
  assert.match(reply, /reunião com o gato Buchudo/i);
});

test('Copiloto não confirma evento ausente no Calendar só porque existe um lembrete interno', async () => {
  const reply = await handleOwnerQuickCommands(baseArgs({
    norm: 'poderia me confirmar?',
    strippedCmd: 'poderia me confirmar?',
    sSelf: {
      history: [
        { role: 'user', content: 'Lembrar o Tauan sobre a reunião com o gato Buchudo, amanhã às 14h' },
        { role: 'assistant', content: 'Lembrete de retorno agendado com sucesso para 26/11/2026 às 14:00 com foco em: "lembrar o Tauan sobre a reunião com o gato Buchudo, amanhã às 14h".' },
        { role: 'user', content: 'poderia me confirmar?' }
      ]
    },
    executeToolCall: async () => ({ success: true, events: [] }),
    reminderStore: {
      listActive: () => [{
        text: 'Lembrar o Tauan sobre a reunião com o gato Buchudo',
        dueAt: '2026-11-26T17:00:00.000Z'
      }]
    }
  }));
  assert.match(reply, /registro interno/i);
  assert.match(reply, /não comprova que exista um evento na Google Agenda/i);
});
