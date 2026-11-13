import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { processMaintenance } from './maintenance.mjs';
import { SupabaseSessionStore } from './supabase-runtime.mjs';

const quietLogger = { warn() {}, error() {} };
const current = Date.parse('2026-11-13T14:00:00.000Z');
const phone = '5588998765432';
const token = 'a247c4f2-e1df-4f50-a2fa-a57f28aa8ea3';

function eligibleSession() {
  return {
    phone,
    human: false,
    lastUserAt: new Date(current - 31 * 3600000).toISOString(),
    lastBotAt: new Date(current - 30 * 3600000).toISOString(),
    history: [
      { role: 'user', content: 'Quero receber uma proposta comercial.' },
      { role: 'assistant', content: 'Vou preparar para você.' }
    ]
  };
}

function remoteStore(session = eligibleSession(), overrides = {}) {
  const calls = { claim: 0, complete: 0, release: 0, flush: 0 };
  const store = {
    sessions: { [phone]: session },
    client: { enabled: true },
    markDirty() {},
    async flush() { calls.flush++; },
    async claimFollowUp() { calls.claim++; return token; },
    async completeFollowUp() { calls.complete++; return true; },
    async releaseFollowUpClaim() { calls.release++; return true; },
    ...overrides
  };
  return { store, calls, session };
}

function run(store, send, logger = quietLogger) {
  return processMaintenance({
    store,
    send,
    now: () => current,
    timeZone: 'America/Fortaleza',
    enableLeadFollowUp: true,
    logger
  });
}

test('claims concorrentes em stores distintos enviam apenas um follow-up', async () => {
  const firstSession = eligibleSession();
  const secondSession = eligibleSession();
  let dbClaimed = false;
  const makeStore = session => remoteStore(session, {
    async claimFollowUp() {
      if (dbClaimed) return null;
      dbClaimed = true;
      return token;
    }
  });
  const a = makeStore(firstSession);
  const b = makeStore(secondSession);
  let sent = 0;
  const send = async () => { sent++; await new Promise(resolve => setTimeout(resolve, 5)); };
  await Promise.all([run(a.store, send), run(b.store, send)]);
  assert.equal(sent, 1);
  assert.equal(a.calls.complete + b.calls.complete, 1);
  assert.equal(a.calls.release + b.calls.release, 0);
});

test('store sem persistência distribuída não envia follow-up', async () => {
  const { store, session } = remoteStore();
  store.client.enabled = false;
  let sent = 0;
  await run(store, async () => { sent++; });
  assert.equal(sent, 0);
  assert.equal(session.followUpSentAt, undefined);
  assert.equal(session.followUpCount, 0);
});

test('claim RPC vazia não envia nem marca a conversa', async () => {
  const { store, calls, session } = remoteStore(undefined, { async claimFollowUp() { calls.claim++; return null; } });
  store.sessions[phone] = eligibleSession();
  Object.assign(session, store.sessions[phone]);
  let sent = 0;
  await run(store, async () => { sent++; });
  assert.equal(sent, 0);
  assert.equal(store.sessions[phone].followUpCount, undefined);
  assert.equal(calls.complete, 0);
});

test('falha da RPC de claim bloqueia envio e deixa estado elegível seguro', async () => {
  const { store, session } = remoteStore(undefined, { async claimFollowUp() { throw new Error('rpc indisponível'); } });
  store.sessions[phone] = eligibleSession();
  Object.assign(session, store.sessions[phone]);
  let sent = 0;
  await run(store, async () => { sent++; });
  assert.equal(sent, 0);
  assert.equal(store.sessions[phone].followUpCount, 0);
  assert.equal(store.sessions[phone].followUpClaimedAt, null);
});

test('confirmação false após envio preserva marca local e nunca libera a claim', async () => {
  const { store, calls, session } = remoteStore(undefined, {
    async completeFollowUp() { calls.complete++; return false; }
  });
  store.sessions[phone] = eligibleSession();
  Object.assign(session, store.sessions[phone]);
  let sent = 0;
  await run(store, async () => { sent++; });
  assert.equal(sent, 1);
  assert.ok(store.sessions[phone].followUpSentAt);
  assert.equal(store.sessions[phone].followUpCount, 1);
  assert.equal(calls.release, 0);
  assert.ok(calls.flush >= 1);
});

test('timeout na conclusão depois do envio preserva follow-up e não libera a claim', async () => {
  const { store, calls, session } = remoteStore(undefined, {
    async completeFollowUp() { calls.complete++; throw new Error('RPC timeout'); }
  });
  store.sessions[phone] = eligibleSession();
  Object.assign(session, store.sessions[phone]);
  let sent = 0;
  await run(store, async () => { sent++; });
  assert.equal(sent, 1);
  assert.ok(store.sessions[phone].followUpSentAt);
  assert.equal(store.sessions[phone].followUpCount, 1);
  assert.equal(calls.release, 0);
  assert.ok(calls.flush >= 1);
});

test('erro de entrega explicitamente anterior ao envio libera claim', async () => {
  const { store, calls, session } = remoteStore();
  const error = Object.assign(new Error('falha antes de enviar'), { beforeSend: true });
  await run(store, async () => { throw error; });
  assert.equal(calls.release, 1);
  assert.equal(session.followUpCount, 0);
  assert.equal(session.followUpClaimedAt, null);
});

test('erro de entrega ambíguo mantém claim e não pode gerar duplicidade', async () => {
  const { store, calls, session } = remoteStore();
  await run(store, async () => { throw new Error('conexão caiu após iniciar o envio'); });
  assert.equal(calls.release, 0);
  assert.equal(session.followUpCount, 1);
  assert.equal(session.followUpClaimToken, token);
});

test('adaptador RPC aceita só UUID para claim e boolean true para completion/release', async () => {
  const outputs = [token, '', true, 1, true, false];
  const client = { enabled: true, async rpc() { return outputs.shift(); } };
  const store = new SupabaseSessionStore(path.join(os.tmpdir(), 'unused-followup-rpc.json'), { client, logger: quietLogger });
  assert.equal(await store.claimFollowUp(phone, new Date(current).toISOString()), token);
  assert.equal(await store.claimFollowUp(phone, new Date(current).toISOString()), null);
  assert.equal(await store.completeFollowUp(phone, token, new Date(current).toISOString()), true);
  assert.equal(await store.completeFollowUp(phone, token, new Date(current).toISOString()), false);
  assert.equal(await store.releaseFollowUpClaim(phone, token), true);
  assert.equal(await store.releaseFollowUpClaim(phone, token), false);
});
