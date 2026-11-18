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
  integrations: { googleCalendar: { enabled: true } }
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
  const oldNodeEnv = process.env.NODE_ENV;
  const oldMock = process.env.GOOGLE_CALENDAR_MOCK;
  process.env.NODE_ENV = 'test';
  process.env.GOOGLE_CALENDAR_MOCK = 'true';
  t.after(() => {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
    if (oldMock === undefined) delete process.env.GOOGLE_CALENDAR_MOCK; else process.env.GOOGLE_CALENDAR_MOCK = oldMock;
  });

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

test('cliente precisa confirmar antes de criar evento e "pode agendar" executa a pendência', async (t) => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldMock = process.env.GOOGLE_CALENDAR_MOCK;
  process.env.NODE_ENV = 'test';
  process.env.GOOGLE_CALENDAR_MOCK = 'true';
  t.after(() => {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
    if (oldMock === undefined) delete process.env.GOOGLE_CALENDAR_MOCK; else process.env.GOOGLE_CALENDAR_MOCK = oldMock;
  });

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
