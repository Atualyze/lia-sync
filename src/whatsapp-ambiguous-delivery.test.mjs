import test from 'node:test';
import assert from 'node:assert/strict';

process.env.EVOLUTION_API_URL = 'https://evolution.invalid';
process.env.EVOLUTION_API_KEY = 'test-key';
process.env.EVOLUTION_INSTANCE = 'test-instance';
const { sendWhatsAppAudio, setOutboundSuppressionCheck } = await import('./whatsapp.mjs');

test('HTTP 2xx com JSON inválido é tratado como resultado de áudio ambíguo', async () => {
  const originalFetch = globalThis.fetch;
  setOutboundSuppressionCheck(async () => null);
  globalThis.fetch = async url => String(url).includes('sendPresence')
    ? { ok: true, status: 200 }
    : { ok: true, status: 200, text: async () => '{json inválido' };
  try {
    await assert.rejects(sendWhatsAppAudio('5511999999999', 'YXVkaW8='), error => {
      assert.equal(error.code, 'evolution_delivery_unknown');
      assert.equal(error.deliveryUnknown, true);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    setOutboundSuppressionCheck(null);
  }
});
