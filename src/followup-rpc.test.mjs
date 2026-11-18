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

function storeWith(session = eligibleSession()) {
  return {
    sessions: { [phone]: session },
    markDirty() {},
    async flush() {}
  };
}

function run(store, stageOutboundDispatch, send = async () => { throw new Error('envio direto não permitido'); }) {
  return processMaintenance({
    store,
    send,
    stageOutboundDispatch,
    now: () => current,
    timeZone: 'America/Fortaleza',
    enableLeadFollowUp: true,
    logger: quietLogger
  });
}

test('follow-up automático vira prévia no Copilot e nunca envia diretamente ao cliente', async () => {
  const session = eligibleSession();
  const store = storeWith(session);
  const staged = [];
  let directSends = 0;
  await run(store, async (prepared, options) => {
    staged.push({ prepared, options });
    return { id: 'A1B2C3D4' };
  }, async () => { directSends += 1; });

  assert.equal(staged.length, 1);
  assert.equal(staged[0].prepared.phone, phone);
  assert.match(staged[0].prepared.message, /avaliar a proposta/i);
  assert.equal(staged[0].options.source, 'maintenance-follow-up');
  assert.equal(staged[0].options.metadata.sourceRef, phone);
  assert.equal(directSends, 0);
  assert.equal(session.followUpSentAt, undefined);
  assert.equal(session.followUpPendingId, 'A1B2C3D4');
  assert.equal(session.followUpCount, 1);
});

test('manutenção falha fechada sem canal de aprovação, mesmo se houver sender', async () => {
  const session = eligibleSession();
  const store = storeWith(session);
  let directSends = 0;
  await run(store, undefined, async () => { directSends += 1; });
  assert.equal(directSends, 0);
  assert.equal(session.followUpSentAt, undefined);
});

test('duas réplicas não enviam diretamente nem duplicam prévias quando o gate compartilhado já está ocupado', async () => {
  const firstStore = storeWith(eligibleSession());
  const secondStore = storeWith(eligibleSession());
  let occupied = false;
  let stagedCount = 0;
  let directSends = 0;
  const stage = async () => {
    if (occupied) return null;
    occupied = true;
    stagedCount += 1;
    return { id: 'D4C3B2A1' };
  };
  await Promise.all([
    run(firstStore, stage, async () => { directSends += 1; }),
    run(secondStore, stage, async () => { directSends += 1; })
  ]);
  assert.equal(stagedCount, 1);
  assert.equal(directSends, 0);
});

test('adaptador RPC de follow-up aceita só UUID para claim e boolean true para completion/release', async () => {
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
