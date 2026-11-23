import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboundMessageScheduler } from './message-scheduler.mjs';

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(fn, delay) {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    }
  };
}

test('agrupa textos do mesmo contato e resolve todas as chamadas do lote', async () => {
  const delivered = [];
  const clock = fakeTimers();
  const scheduler = createInboundMessageScheduler({
    delayMs: 8,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    deliver: async batch => {
      delivered.push({ phone: batch.phone, text: batch.text, keyId: batch.keyId });
      return 'ok';
    }
  });

  const first = scheduler.schedule({ phone: '5511999990001', text: 'Oi', keyId: 'm1' });
  const firstTimer = clock.timers[0];
  const second = scheduler.schedule({ phone: '5511999990001', text: 'Tenho uma dúvida', keyId: 'm2' });
  assert.equal(firstTimer.cleared, true);
  assert.equal(scheduler.pendingCount, 1);

  clock.timers[1].fn();
  assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);
  assert.deepEqual(delivered, [{
    phone: '5511999990001',
    text: 'Oi\nTenho uma dúvida',
    keyId: 'm2'
  }]);
  assert.equal(scheduler.pendingCount, 0);
});

test('mídia força o flush do texto anterior antes de ser entregue', async () => {
  const order = [];
  const clock = fakeTimers();
  const scheduler = createInboundMessageScheduler({
    delayMs: 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isImmediate: job => job.mediaType === 'audio',
    deliver: async job => {
      order.push(job.mediaType || 'text');
      return job.mediaType || 'text';
    }
  });

  const text = scheduler.schedule({ phone: '5511999990002', text: 'Veja isso' });
  const audio = scheduler.schedule({ phone: '5511999990002', text: '', mediaType: 'audio', nonText: true });

  assert.deepEqual(await Promise.all([text, audio]), ['text', 'audio']);
  assert.deepEqual(order, ['text', 'audio']);
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(scheduler.pendingCount, 0);
});

test('flush/drain descarrega lotes pendentes sem esperar o timer', async () => {
  const delivered = [];
  const clock = fakeTimers();
  const scheduler = createInboundMessageScheduler({
    delayMs: 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    deliver: async job => { delivered.push(job.phone); }
  });

  const pending = scheduler.schedule({ phone: '5511999990003', text: 'Mensagem' });
  const result = await scheduler.drain();
  await pending;

  assert.deepEqual(result, { flushed: 1, failed: 0 });
  assert.deepEqual(delivered, ['5511999990003']);
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(scheduler.pendingCount, 0);
});

test('lotes de contatos diferentes não são misturados', async () => {
  const delivered = [];
  const clock = fakeTimers();
  const scheduler = createInboundMessageScheduler({
    delayMs: 5,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    deliver: async job => { delivered.push({ phone: job.phone, text: job.text }); }
  });

  const first = scheduler.schedule({ phone: '5511999990004', text: 'A' });
  const second = scheduler.schedule({ phone: '5511999990005', text: 'B' });
  clock.timers[0].fn();
  clock.timers[1].fn();
  await Promise.all([first, second]);

  assert.equal(delivered.length, 2);
  assert.deepEqual(new Set(delivered.map(item => item.text)), new Set(['A', 'B']));
});

test('falha do lote rejeita todos os chamadores e libera a entrada pendente', async () => {
  const failure = new Error('falha de processamento');
  const clock = fakeTimers();
  const scheduler = createInboundMessageScheduler({
    delayMs: 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    deliver: async () => { throw failure; }
  });
  const first = scheduler.schedule({ phone: '5511999990006', text: 'A' });
  const second = scheduler.schedule({ phone: '5511999990006', text: 'B' });
  const flushed = scheduler.flush('5511999990006');

  await assert.rejects(first, /falha de processamento/);
  await assert.rejects(second, /falha de processamento/);
  await assert.rejects(flushed, /falha de processamento/);
  assert.equal(scheduler.pendingCount, 0);
});

test('mídias imediatas consecutivas mantêm a ordem de chegada', async () => {
  const order = [];
  const clock = fakeTimers();
  const scheduler = createInboundMessageScheduler({
    delayMs: 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isImmediate: job => Boolean(job.mediaType),
    deliver: async job => {
      order.push(job.text);
      return job.text;
    }
  });

  const first = scheduler.schedule({ phone: '5511999990008', text: 'áudio-1', mediaType: 'audio' });
  const second = scheduler.schedule({ phone: '5511999990008', text: 'imagem-2', mediaType: 'image' });

  assert.deepEqual(order, ['áudio-1', 'imagem-2']);
  await Promise.all([first, second]);
});
