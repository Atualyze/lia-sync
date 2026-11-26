import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleMissedCallTextBack, cancelMissedCall } from './missed-call.mjs';

test('scheduleMissedCallTextBack envia mensagem após delay e cancelMissedCall cancela quando necessário', async () => {
  const sent = [];
  const res = scheduleMissedCallTextBack({
    phone: '+55 (11) 98888-1234',
    delaySeconds: 0.05,
    message: 'Oi! Vi sua ligação perdida. Como posso ajudar?',
    sendText: async (to, text) => sent.push({ to, text }),
  });

  assert.equal(res.scheduled, true);
  assert.equal(res.phone, '5511988881234');

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sent.length, 1);
  assert.match(sent[0].to, /5511988881234@s\.whatsapp\.net$/);
  assert.match(sent[0].text, /ligação perdida/);

  // Teste de cancelamento
  const sent2 = [];
  scheduleMissedCallTextBack({
    phone: '5511977770000',
    delaySeconds: 1,
    sendText: async (to, text) => sent2.push({ to, text }),
  });
  assert.equal(cancelMissedCall('5511977770000'), true);
  assert.equal(sent2.length, 0);
});
