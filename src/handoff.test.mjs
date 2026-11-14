import test from 'node:test';
import assert from 'node:assert/strict';
import { summary, buildHandoffSummary, triggerHandoff } from './handoff.mjs';

test('summary e buildHandoffSummary geram resumo com motivo e urgencia', () => {
  const session = {
    clientName: 'Maria',
    phone: '5511999998888',
    history: [{ role: 'user', content: 'Preciso de suporte' }]
  };
  const text = summary(session, 'duvida', 'alta');
  assert.equal(text, buildHandoffSummary(session, 'duvida', 'alta'));
  assert.match(text, /Maria/);
  assert.match(text, /duvida/);
});

test('triggerHandoff marca sessao como humana e notifica com sucesso', async () => {
  const session = { phone: '5511999998888', history: [] };
  let notified = '';
  const result = await triggerHandoff(session, {
    reason: 'cliente pediu humano',
    urgency: 'normal',
    notify: async (msg) => { notified = msg; }
  });
  assert.equal(session.human, true);
  assert.equal(session.handoffNotified, true);
  assert.equal(session.handoffNotifyFailed, false);
  assert.ok(notified.includes('cliente pediu humano'));
  assert.ok(result);
});

test('triggerHandoff registra falha quando notify rejeita', async () => {
  const session = { phone: '5511999998888', history: [] };
  await triggerHandoff(session, {
    reason: 'erro',
    urgency: 'alta',
    notify: async () => { throw new Error('falha envio'); }
  });
  assert.equal(session.human, true);
  assert.equal(session.handoffNotifyFailed, true);
});
