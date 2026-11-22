import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyReactivationToInternalChat, triggerSmartReactivationContinuation } from './http/reactivation-notice.mjs';
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

test('triggerSmartReactivationContinuation: responde automaticamente cliente sem resposta recente ("Bom dia") e preserva proteção em conversa já respondida ou antiga', async () => {
  const nowMs = Date.now();
  const selfSession = { phone: OWNER_SELF_KEY, history: [] };
  const unansweredClient = {
    phone: '5588999991111',
    clientName: 'Lucas',
    human: false,
    history: [{ role: 'user', content: 'Bom dia', createdAt: new Date(nowMs - 60_000).toISOString() }]
  };
  const answeredClient = {
    phone: '5588999992222',
    clientName: 'Bia',
    human: false,
    history: [
      { role: 'user', content: 'Bom dia', createdAt: new Date(nowMs - 120_000).toISOString() },
      { role: 'assistant', content: 'Bom dia Bia!', createdAt: new Date(nowMs - 60_000).toISOString() }
    ]
  };
  const staleClient = {
    phone: '5588999993333',
    clientName: 'Pedro',
    human: false,
    history: [{ role: 'user', content: 'Oi', createdAt: new Date(nowMs - 24 * 3600_000).toISOString() }]
  };
  const store = makeStore({
    [OWNER_SELF_KEY]: selfSession,
    '5588999991111': unansweredClient,
    '5588999992222': answeredClient,
    '5588999993333': staleClient
  });

  const sent = [];
  const processedOrigins = [];
  const fakeFlow = {
    process: async (args) => {
      processedOrigins.push(args.origin);
      return 'Bom dia, Lucas! Em que posso te ajudar hoje?';
    }
  };
  const sendReply = async (target, text) => sent.push({ target, text });

  // 1) Cliente deixou "Bom dia" recente no vácuo -> Lia responde automaticamente
  const r1 = await triggerSmartReactivationContinuation({
    store, session: unansweredClient, phone: '5588999991111', flow: fakeFlow, sendReply, now: () => nowMs
  });
  assert.equal(r1.continued, true);
  assert.equal(processedOrigins[0], 'reactivation_auto');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Bom dia, Lucas/);
  assert.match(selfSession.history.at(-1).content, /já respondi à última mensagem/i);

  // 2) Conversa já respondida pelo humano -> NÃO incomoda cliente
  const r2 = await triggerSmartReactivationContinuation({
    store, session: answeredClient, phone: '5588999992222', flow: fakeFlow, sendReply, now: () => nowMs
  });
  assert.equal(r2.continued, false);
  assert.equal(r2.reason, 'already_answered');
  assert.equal(sent.length, 1);

  // 3) Mensagem antiga (> 12h) -> NÃO acorda cliente antigo
  const r3 = await triggerSmartReactivationContinuation({
    store, session: staleClient, phone: '5588999993333', flow: fakeFlow, sendReply, now: () => nowMs
  });
  assert.equal(r3.continued, false);
  assert.equal(r3.reason, 'stale_message');
  assert.equal(sent.length, 1);
});
