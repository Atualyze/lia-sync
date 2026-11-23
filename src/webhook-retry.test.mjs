import test from 'node:test';
import assert from 'node:assert/strict';
import { processWhatsAppWebhookPayload } from './http/webhook.mjs';

function makePayload(id = 'event-1') {
  return {
    event: 'MESSAGES_UPSERT',
    instance: 'baileys',
    data: {
      key: {
        remoteJid: '5511999990007@s.whatsapp.net',
        id,
        fromMe: false
      },
      message: { conversation: 'Oi' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: 'Ana'
    }
  };
}

function makeDeps({ schedule, f, finished }) {
  const session = { phone: '5511999990007', human: false, history: [] };
  return {
    payload: makePayload(),
    store: {
      get: () => session,
      rememberLid() {},
      markDirty() {}
    },
    f: {
      isDuplicate: () => false,
      allowRate: () => true,
      shouldWarnRate: () => false,
      ...f
    },
    adminConfig: { active: { identity: { botName: 'Lia', responsible: 'Equipe' } } },
    schedule,
    getHumanPhone: () => '5511888888888',
    getCachedInstanceOwner: () => null,
    updateInstanceOwner: async () => {},
    rateMessage: 'rate limit',
    webhookEventStore: {
      async begin() { return { tracked: true, duplicate: false, key: 'hashed-event', attemptCount: 1 }; },
      async finish(_tracking, status, code) { finished.push({ status, code }); }
    },
    campaignStore: null,
    prospecting: null
  };
}

test('webhook libera a deduplicação quando o processamento falha antes de enviar', async () => {
  const released = [];
  const finished = [];
  const deps = makeDeps({
    schedule: async () => { throw new Error('falha antes do envio'); },
    f: { releaseDuplicate: id => { released.push(id); return true; } },
    finished
  });

  await processWhatsAppWebhookPayload(deps);

  assert.deepEqual(released, ['event-1']);
  assert.deepEqual(finished, [{ status: 'failed', code: 'Error' }]);
});

test('webhook não libera retry automático quando o resultado do envio é incerto', async () => {
  const released = [];
  const finished = [];
  const uncertain = Object.assign(new Error('timeout ao enviar'), { deliveryOutcomeUncertain: true });
  const deps = makeDeps({
    schedule: async () => { throw uncertain; },
    f: { releaseDuplicate: id => { released.push(id); return true; } },
    finished
  });

  await processWhatsAppWebhookPayload(deps);

  assert.deepEqual(released, []);
  assert.deepEqual(finished, [{ status: 'ignored', code: 'delivery_outcome_uncertain' }]);
});
