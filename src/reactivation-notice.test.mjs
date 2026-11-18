import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyReactivationToInternalChat } from './http/reactivation-notice.mjs';
import { handlePendingReactivationReply } from './flow/reactivation-reply.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';

function makeStore(initialSessions = {}) {
  const map = new Map(Object.entries(initialSessions));
  let dirty = false;
  return {
    get(key) { return map.get(key) || null; },
    markDirty() { dirty = true; },
    isDirty() { return dirty; }
  };
}

test('notifyReactivationToInternalChat: detects unanswered client (no vácuo) and asks in internal chat', () => {
  const selfSession = { phone: OWNER_SELF_KEY, history: [] };
  const clientSession = {
    phone: '5511999990000',
    clientName: 'Marina',
    history: [
      { role: 'model', text: 'Oi Marina, tudo bem?' },
      { role: 'user', text: 'Qual o valor do plano mensal?' }
    ]
  };
  const store = makeStore({ [OWNER_SELF_KEY]: selfSession, '5511999990000': clientSession });

  const result = notifyReactivationToInternalChat({ store, session: clientSession, phone: '5511999990000' });
  assert.equal(result.unanswered, true);
  assert.match(result.message, /no vácuo/i);
  assert.match(result.message, /Marina/);
  assert.equal(selfSession.history.length, 1);
  assert.equal(store.isDirty(), true);
});

test('notifyReactivationToInternalChat: detects already answered conversation and asks if Lia can continue', () => {
  const selfSession = { phone: OWNER_SELF_KEY, history: [] };
  const clientSession = {
    phone: '5511999990001',
    clientName: 'Carlos',
    history: [
      { role: 'user', text: 'Vocês aceitam Pix?' },
      { role: 'model', text: 'Sim, aceitamos Pix na hora!' }
    ]
  };
  const store = makeStore({ [OWNER_SELF_KEY]: selfSession, '5511999990001': clientSession });

  const result = notifyReactivationToInternalChat({ store, session: clientSession, phone: '5511999990001' });
  assert.equal(result.unanswered, false);
  assert.match(result.message, /respondida pelo atendimento humano/i);
  assert.match(result.message, /Carlos/);
  assert.equal(selfSession.history.length, 1);
});

test('handlePendingReactivationReply: keeps human mode, closes session, or stages a resumed reply for approval', async () => {
  const clientA = { phone: '5511999990002', clientName: 'Ana', human: false, history: [{ role: 'user', text: 'Tem vaga?' }] };
  const selfSession = { phone: OWNER_SELF_KEY, history: [] };
  const store = makeStore({ [OWNER_SELF_KEY]: selfSession, '5511999990002': clientA });

  // 1) Admin says "eu resolvo" -> returns to human mode
  notifyReactivationToInternalChat({ store, session: clientA, phone: '5511999990002' });
  const rHuman = await handlePendingReactivationReply({
    store, sSelf: selfSession, cleanCommand: 'Eu resolvo aqui, mantém no humano', now: () => Date.now(), owner: 'Tauan'
  });
  assert.match(rHuman, /modo humano/i);
  assert.equal(clientA.human, true);
  assert.equal(selfSession.pendingReactivation, null);

  // 2) Admin says "já resolvi, pode encerrar" -> closes session
  notifyReactivationToInternalChat({ store, session: clientA, phone: '5511999990002' });
  const rClose = await handlePendingReactivationReply({
    store, sSelf: selfSession, cleanCommand: 'Já resolvi, pode encerrar', now: () => Date.now(), owner: 'Tauan'
  });
  assert.match(rClose, /encerr/i);
  assert.equal(clientA.human, false);
  assert.equal(clientA.inactivityClosed, true);

  // 3) Admin says "pode continuar" -> Lia creates a preview but does not send before approval
  const sent = [];
  const staged = [];
  notifyReactivationToInternalChat({ store, session: clientA, phone: '5511999990002' });
  const rBot = await handlePendingReactivationReply({
    store,
    sSelf: selfSession,
    cleanCommand: 'Pode continuar e responder ela',
    now: () => Date.now(),
    owner: 'Tauan',
    botConfig: {},
    ai: { askAI: async () => ({ text: 'Oi Ana! Temos vaga sim, qual horário fica melhor para você?' }) },
    stageOutboundDispatch: async (payload, options) => {
      staged.push({ payload, options });
      return `Prévia de disparo aguardando confirmação: ${payload.message}`;
    },
    whatsapp: { sendText: async (jid, text) => sent.push({ jid, text }) }
  });
  assert.match(rBot, /prévia.*confirmação/i);
  assert.equal(sent.length, 0);
  assert.equal(staged.length, 1);
  assert.match(staged[0].payload.message, /Temos vaga sim/);
  assert.equal(staged[0].options.source, 'reactivation');
  assert.equal(clientA.human, false);
  assert.equal(clientA.inactivityClosed, true, 'a retomada só muda o estado ao aprovar o disparo');
});
