import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyReactivationToInternalChat } from './http/reactivation-notice.mjs';
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
