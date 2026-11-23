export function createRuntimeAlertNotifier({
  throttle,
  getWhatsAppTarget,
  sendWhatsApp,
  getTelegramNotifier,
  redact = value => value,
  formatWhatsAppMessage = value => value,
  logger = console
} = {}) {
  return async function notifyRuntimeAlert(key, message) {
    if (!throttle?.allow?.(key)) return false;

    const safeMessage = redact(String(message || '').slice(0, 3000));
    const tasks = [];
    const target = getWhatsAppTarget?.();
    if (target && typeof sendWhatsApp === 'function') {
      tasks.push({
        channel: 'whatsapp',
        promise: Promise.resolve().then(() => sendWhatsApp(target, formatWhatsAppMessage(safeMessage)))
      });
    }
    const notifyTelegram = getTelegramNotifier?.();
    if (typeof notifyTelegram === 'function') {
      tasks.push({ channel: 'telegram', promise: Promise.resolve().then(() => notifyTelegram(safeMessage)) });
    }

    if (!tasks.length) {
      throttle.reset?.(key);
      logger.error('[runtime-alert] Nenhum canal do responsável disponível para alerta:', key);
      return false;
    }

    const results = await Promise.allSettled(tasks.map(task => task.promise));
    const delivered = results.some((result, index) => result.status === 'fulfilled'
      && (tasks[index].channel !== 'telegram' || Number(result.value?.sent) > 0));
    if (!delivered) {
      throttle.reset?.(key);
      logger.error('[runtime-alert] Não foi possível entregar o alerta:', key);
      return false;
    }
    return true;
  };
}

export function notifyBeforeShutdown({ notify, stop, timeoutMs = 2500 } = {}) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(resolve, Math.max(0, Number(timeoutMs) || 0));
  });
  const notification = Promise.resolve().then(() => notify?.()).catch(() => undefined);
  return Promise.race([notification, timeout]).finally(() => {
    clearTimeout(timer);
    return stop?.(1);
  });
}
