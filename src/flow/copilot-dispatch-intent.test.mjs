import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPendingOutboundIntent, parsePendingOutboundIntent } from './copilot-dispatch-intent.mjs';

const pending = {
  id: 'ABC123',
  recipient: 'ptbr',
  phone: '5588998340085',
  message: 'Mensagem preparada',
  status: 'uncertain',
  createdAt: '2026-11-20T08:00:00.000Z'
};

test('interpreta linguagem natural para encerrar uma pendência', async () => {
  const result = await classifyPendingOutboundIntent({
    ai: { askAI: async () => ({ reply: '{"intent":"resolve","confidence":0.96,"reason":"pedido de encerramento da pendência"}' }) },
    message: 'Ok, marque como concluído',
    pending,
    recentContext: [{ role: 'assistant', content: 'O disparo está incerto.' }]
  });
  assert.equal(result.intent, 'resolve');
  assert.ok(result.confidence >= 0.72);
});

test('interpreta autorização natural sem depender da frase sim', async () => {
  const result = await classifyPendingOutboundIntent({
    ai: { askAI: async () => ({ reply: '{"intent":"approve","confidence":0.95,"reason":"autorização para enviar"}' }) },
    message: 'Pode seguir com esse envio',
    pending
  });
  assert.equal(result.intent, 'approve');
});

test('não transforma resposta ambígua em decisão', async () => {
  const result = await classifyPendingOutboundIntent({
    ai: { askAI: async () => ({ reply: '{"intent":"resolve","confidence":0.51,"reason":"ambíguo"}' }) },
    message: 'ok',
    pending
  });
  assert.equal(result.intent, 'none');
});

test('parser falha fechado', () => {
  assert.deepEqual(parsePendingOutboundIntent('não é json'), {
    intent: 'none',
    confidence: 0,
    reason: 'invalid_response'
  });
});
