import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createFlow } from './flow.mjs';
import { SessionStore } from './sessions.mjs';
import { ReminderStore } from './reminders.mjs';
import { isClientToolAllowed } from './tools/index.mjs';

const baseConfig = {
  identity: { botName: 'Lia', responsible: 'Equipe' },
  ai: { agentMode: 'super_agente', enableToolCalling: true },
  integrations: { googleCalendar: { enabled: true, showMockSlotsWhenUnavailable: true } },
  tools: { settings: { gerenciar_agenda_google: { calendarId: 'test-calendar' } } }
};

async function makeStore(label) {
  const store = new SessionStore(path.join(os.tmpdir(), `schedule-flow-${label}-${Date.now()}-${Math.random()}.json`));
  await store.load();
  return store;
}

test('agenda do Google é permitida no fluxo de cliente quando habilitada', () => {
  assert.equal(isClientToolAllowed('gerenciar_agenda_google'), true);
});

test('fluxo do cliente retorna horários reais da agenda em vez de deixar promessa pendente', async (t) => {


  const store = await makeStore('calendar-success');
  const reminderStore = new ReminderStore(path.join(os.tmpdir(), `schedule-reminders-${Date.now()}.json`));
  await reminderStore.load();
  const flow = createFlow({
    store,
    reminderStore,
    getBotConfig: () => baseConfig,
    faq: async () => [],
    ai: {
      askAI: async () => ({
        reply: 'Vou consultar os horários disponíveis agora.',
        intent: 'agendamento',
        tool_calls: [{ name: 'gerenciar_agenda_google', args: { action: 'consultar_livres', date: 'amanhã' } }]
      })
    }
  });

  const reply = await flow.process({ phone: '5511999990001', text: 'Quais horários você tem amanhã?' });
  assert.match(reply, /horários disponíveis/i);
  assert.match(reply, /09:00/);
  assert.doesNotMatch(reply, /vou consultar.*agora/i);
});

test('falha da agenda também gera resposta e não deixa o cliente sem retorno', async () => {
  const store = await makeStore('calendar-error');
  const reminderStore = new ReminderStore(path.join(os.tmpdir(), `schedule-reminders-error-${Date.now()}.json`));
  await reminderStore.load();
  const config = { ...baseConfig, integrations: { googleCalendar: { enabled: false } } };
  const flow = createFlow({
    store,
    reminderStore,
    getBotConfig: () => config,
    faq: async () => [],
    ai: {
      askAI: async () => ({
        reply: 'Vou verificar sua agenda.',
        intent: 'agendamento',
        tool_calls: [{ name: 'gerenciar_agenda_google', args: { action: 'consultar_livres', date: 'amanhã' } }]
      })
    }
  });

  const reply = await flow.process({ phone: '5511999990002', text: 'Pode olhar os horários de amanhã?' });
  assert.match(reply, /desativada|não.*agenda|equipe/i);
  assert.doesNotMatch(reply, /vou verificar sua agenda/i);
});

test('cliente: pedido vago para guardar recado não executa tool_call nem reminder', async () => {
  const nowMs = Date.parse('2026-11-25T16:38:00.000Z');
  const store = await makeStore('generic-note-no-reminder');
  let reminderWrites = 0;
  const reminderStore = {
    add: async () => {
      reminderWrites += 1;
      return { id: 'unexpected-reminder' };
    }
  };
  const modelResponses = [
    {
      reply: '',
      intent: 'lembrete',
      tool_calls: [{
        name: 'agendar_retorno_ou_followup',
        args: { reason: 'Recado de Nauat', when: '2026-11-25T14:00:00-03:00' }
      }],
      reminder: { text: 'Recado de Nauat', dueAt: '2026-11-25T14:00:00-03:00' }
    },
    {
      reply: 'Claro, vou guardar o recado.',
      intent: 'lembrete',
      reminder: { text: 'Recado de Nauat', dueAt: '2026-11-25T14:00:00-03:00' }
    }
  ];

  for (let index = 0; index < modelResponses.length; index += 1) {
    const flow = createFlow({
      store,
      now: () => nowMs,
      reminderStore,
      getBotConfig: () => baseConfig,
      faq: async () => [],
      ai: { askAI: async () => modelResponses[index] }
    });
    const reply = await flow.process({
      phone: `551199999000${index}`,
      text: 'poderia guardar um recado?',
      origin: 'real'
    });
    assert.match(reply, /Qual recado você gostaria que eu guardasse/i);
  }

  assert.equal(reminderWrites, 0, 'nenhuma sugestão fabricada pela IA pode criar lembrete sem pedido explícito');
});

test('cliente precisa confirmar antes de criar evento e "pode agendar" executa a pendência', async (t) => {


  const store = await makeStore('calendar-confirmation');
  let aiCalls = 0;
  const flow = createFlow({
    store,
    getBotConfig: () => baseConfig,
    faq: async () => [],
    ai: {
      askAI: async () => {
        aiCalls += 1;
        return aiCalls === 1
          ? { reply: 'Vou reservar esse horário.', tool_calls: [{ name: 'gerenciar_agenda_google', args: { action: 'criar_evento', date: 'amanhã', startTime: '14:30', summary: 'Atendimento' } }] }
          : { reply: '', tool_calls: [] };
      }
    }
  });

  const first = await flow.process({ phone: '5511999990003', text: 'Quero agendar amanhã às 14:30' });
  assert.match(first, /confirma|agendar/i);
  assert.doesNotMatch(first, /agendado com sucesso/i);
  assert.ok(store.get('5511999990003').pendingClientAgenda);

  const second = await flow.process({ phone: '5511999990003', text: 'Pode sim' });
  assert.match(second, /sucesso/i);
  assert.equal(store.get('5511999990003').pendingClientAgenda, null);
});
