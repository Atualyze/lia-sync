import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlertThrottle } from './alert-throttle.mjs';
import { createRuntimeAlertNotifier, notifyBeforeShutdown } from './runtime-alerts.mjs';

const quietLogger = { error() {} };

test('falhas de entrega e Telegram com sent=0 liberam uma nova tentativa', async () => {
  const throttle = createAlertThrottle({ windowMs: 60_000 });
  let telegramCalls = 0;
  let whatsappCalls = 0;
  const notify = createRuntimeAlertNotifier({
    throttle,
    getWhatsAppTarget: () => '5511999999999',
    sendWhatsApp: async () => {
      whatsappCalls += 1;
      throw new Error('temporarily unavailable');
    },
    getTelegramNotifier: () => async () => ({ sent: ++telegramCalls > 1 ? 1 : 0 }),
    logger: quietLogger
  });

  assert.equal(await notify('runtime', 'alerta'), false);
  assert.equal(await notify('runtime', 'alerta'), true);
  assert.equal(await notify('runtime', 'alerta'), false);
  assert.equal(telegramCalls, 2);
  assert.equal(whatsappCalls, 2);
});

test('ausência de canais não consome a janela de throttle', async () => {
  const throttle = createAlertThrottle({ windowMs: 60_000 });
  let target = '';
  const notify = createRuntimeAlertNotifier({
    throttle,
    getWhatsAppTarget: () => target,
    sendWhatsApp: async () => undefined,
    logger: quietLogger
  });

  assert.equal(await notify('runtime', 'alerta'), false);
  target = '5511999999999';
  assert.equal(await notify('runtime', 'alerta'), true);
});

test('notifyBeforeShutdown inicia stop após alerta pendente atingir o prazo', async () => {
  let exitCode = null;
  await notifyBeforeShutdown({
    notify: () => new Promise(() => {}),
    stop: code => { exitCode = code; },
    timeoutMs: 10
  });
  assert.equal(exitCode, 1);
});

test('notifyBeforeShutdown espera um alerta breve antes de iniciar stop', async () => {
  const events = [];
  await notifyBeforeShutdown({
    notify: async () => { events.push('alert'); },
    stop: code => { events.push(`stop:${code}`); },
    timeoutMs: 100
  });
  assert.deepEqual(events, ['alert', 'stop:1']);
});
