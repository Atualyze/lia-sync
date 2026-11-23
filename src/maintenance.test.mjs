import test from 'node:test';
import assert from 'node:assert/strict';
import { processMaintenance } from './maintenance.mjs';

function createMockStore() {
  const sessions = {};
  let dirty = false;
  let flushed = false;
  return {
    sessions,
    dirty: () => dirty,
    markDirty: () => { dirty = true; },
    flush: async () => { flushed = true; dirty = false; },
    isFlushed: () => flushed
  };
}

test('Maintenance: dispara lembrete de atendimento uma única vez e marca store.markDirty', async () => {
  const store = createMockStore();
  const phone = '5511999991234';
  const handoffTime = new Date(Date.now() - 20 * 60000).toISOString();

  store.sessions[phone] = {
    phone,
    clientName: 'Cliente Teste',
    human: true,
    handoffAt: handoffTime,
    handoffReminder1Sent: false
  };

  const notifications = [];
  await processMaintenance({
    store,
    notify: async (msg) => notifications.push(msg),
    humanReminderMinutes: 15,
    humanPhone: '5588921694598',
    disableInactivityPings: true
  });

  assert.equal(notifications.length, 1, 'Deve ter disparado exatamente 1 lembrete');
  assert.match(notifications[0], /Cliente Teste/);
  assert.equal(store.sessions[phone].handoffReminder1Sent, true, 'Deve marcar handoffReminder1Sent como true');
  assert.ok(store.sessions[phone].handoffReminderSentAt, 'Deve ter data/hora do lembrete');

  // Segunda rodada: NÃO deve disparar novamente
  notifications.length = 0;
  await processMaintenance({
    store,
    notify: async (msg) => notifications.push(msg),
    humanReminderMinutes: 15,
    humanPhone: '5588921694598',
    disableInactivityPings: true
  });

  assert.equal(notifications.length, 0, 'NÃO deve disparar lembrete novamente na segunda rodada');
});

test('Maintenance: NÃO envia lembrete se o atendente humano já assumiu (takeover)', async () => {
  const store = createMockStore();
  const phone = '5511999991234';

  store.sessions[phone] = {
    phone,
    human: true,
    humanSource: 'takeover',
    takeoverAt: new Date().toISOString(),
    handoffAt: new Date(Date.now() - 30 * 60000).toISOString(),
    handoffReminder1Sent: false
  };

  const notifications = [];
  await processMaintenance({
    store,
    notify: async (msg) => notifications.push(msg),
    humanReminderMinutes: 15,
    humanPhone: '5588921694598',
    disableInactivityPings: true
  });

  assert.equal(notifications.length, 0, 'Não deve notificar se atendente já assumiu o chat');
});

test('Maintenance: NÃO envia lembrete para a sessão do próprio atendente', async () => {
  const store = createMockStore();
  const phone = '5588921694598';

  store.sessions[phone] = {
    phone,
    human: true,
    handoffAt: new Date(Date.now() - 30 * 60000).toISOString(),
    handoffReminder1Sent: false
  };

  const notifications = [];
  await processMaintenance({
    store,
    notify: async (msg) => notifications.push(msg),
    humanReminderMinutes: 15,
    humanPhone: '5588921694598',
    disableInactivityPings: true
  });

  assert.equal(notifications.length, 0, 'Não deve notificar a si próprio');
});

test('Maintenance: pings de inatividade estão desativados por padrão para não incomodar clientes', async () => {
  const store = createMockStore();
  const phone = '5511988887777';

  store.sessions[phone] = {
    phone,
    human: false,
    awaitingReply: true,
    lastBotAt: new Date(Date.now() - 15 * 60000).toISOString(), // 15 min atrás
    inactivityStage: 0
  };

  const sent = [];
  await processMaintenance({
    store,
    send: async (p, m) => sent.push({ p, m }),
    disableInactivityPings: true
  });

  assert.equal(sent.length, 0, 'Não deve enviar mensagens automáticas de inatividade para o cliente');
});


test('Maintenance: não retoma automaticamente uma sessão humana mesmo com configuração legada de timeout', async () => {
  const store = createMockStore();
  const phone = '5511999991234';
  const handoffAt = new Date(Date.now() - 3 * 3600000).toISOString();
  store.sessions[phone] = {
    phone,
    clientName: 'Cliente em atendimento',
    human: true,
    humanSource: 'admin',
    handoffAt,
    handoffReminder1Sent: true,
    pendingTurnPostponedUntil: new Date(Date.now() - 60000).toISOString(),
    lastBotAt: new Date(Date.now() - 30 * 3600000).toISOString(),
    lastUserAt: new Date(Date.now() - 31 * 3600000).toISOString(),
    followUpCount: 0,
    pendingCheckout: {
      checkoutUrl: 'https://pay.example.test/checkout',
      createdAt: new Date(Date.now() - 60 * 60000).toISOString()
    },
    history: [
      { role: 'user', content: 'Quero contratar o serviço' },
      { role: 'assistant', content: 'Vou confirmar os detalhes com a equipe.' }
    ]
  };

  let postponedResumeCalls = 0;
  let stagedCustomerMessages = 0;
  let paymentChecks = 0;

  await processMaintenance({
    store,
    humanAutoResumeHours: 1,
    humanReminderMinutes: Number.MAX_SAFE_INTEGER,
    autoResumeOnOpen: true,
    onPostponedResume: async () => {
      postponedResumeCalls += 1;
      return { continued: true };
    },
    enableLeadFollowUp: true,
    followUpMinHours: 24,
    followUpMaxHours: 72,
    stageOutboundDispatch: async () => {
      stagedCustomerMessages += 1;
      return { id: 'unexpected-preview' };
    },
    checkPayment: async () => {
      paymentChecks += 1;
      return { paid: false };
    }
  });

  assert.equal(store.sessions[phone].human, true);
  assert.equal(store.sessions[phone].humanSource, 'admin');
  assert.equal(store.sessions[phone].handoffAt, handoffAt);
  assert.equal(postponedResumeCalls, 0, 'não deve executar retomada de turno adiado');
  assert.equal(stagedCustomerMessages, 0, 'não deve preparar follow-up nem recuperação de checkout');
  assert.equal(paymentChecks, 0, 'não deve consultar checkout de sessão em atendimento humano');
});
