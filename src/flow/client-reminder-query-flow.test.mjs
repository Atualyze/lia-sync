import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFlow } from '../flow.mjs';
import { SessionStore } from '../sessions.mjs';
import { ReminderStore } from '../reminders.mjs';

test('cliente consulta, conta e confirma lembretes sem depender da IA', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-client-reminder-query-'));
  const sessionStore = new SessionStore(path.join(dir, 'sessions.json'), { logger: { error() {} } });
  const reminderStore = new ReminderStore(path.join(dir, 'reminders.json'), { logger: { warn() {}, error() {} } });
  await sessionStore.load();
  await reminderStore.load();

  const phone = '5588998340085';
  const dueAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await reminderStore.add({
    phone,
    clientName: 'Contato teste',
    text: 'Reunião com o gato Buchudo',
    dueAt
  });
  await reminderStore.add({
    phone: '5588998340086',
    clientName: 'Outro contato',
    text: 'Dado privado de outro contato',
    dueAt
  });

  const session = sessionStore.get(phone);
  session.phone = phone;
  session.clientName = 'Contato teste';
  session.history = [{
    role: 'assistant',
    content: '✅ Lembrete agendado para amanhã às 14h.',
    createdAt: new Date().toISOString()
  }];
  sessionStore.markDirty();

  let aiCalls = 0;
  const flow = createFlow({
    store: sessionStore,
    reminderStore,
    faq: async () => [],
    getBotConfig: () => ({
      identity: { botName: 'Lia', responsible: 'Tauan' },
      ai: { agentMode: 'super_agente', enableToolCalling: true }
    }),
    ai: {
      askAI: async () => {
        aiCalls += 1;
        return { reply: 'Resposta genérica do modelo.', tool_calls: [] };
      }
    },
    logger: { debug() {}, warn() {}, error() {} }
  });

  try {
    const confirmed = await flow.process({
      phone,
      text: 'poderia me confirmar?',
      origin: 'real'
    });
    assert.match(confirmed, /Reunião com o gato Buchudo/);
    assert.match(confirmed, /registro do sistema de lembretes/i);
    assert.doesNotMatch(confirmed, /Dado privado de outro contato/);

    const counted = await flow.process({
      phone,
      text: 'quantos lembretes tem no meu contato',
      origin: 'real'
    });
    assert.match(counted, /1 lembrete/);

    const listed = await flow.process({
      phone,
      text: 'o que tem agendado?',
      origin: 'real'
    });
    assert.match(listed, /Reunião com o gato Buchudo/);
    assert.doesNotMatch(listed, /Dado privado de outro contato/);
    assert.equal(aiCalls, 0, 'consultas de lembretes devem ser determinísticas e não consumir turno da IA');
  } finally {
    await sessionStore.flush();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
