const DEFAULT_IMMEDIATE_TYPES = new Set(['audio', 'image', 'video']);

/**
 * Agrupa mensagens de texto próximas do mesmo contato sem inverter a ordem
 * quando uma mídia chega antes do debounce terminar.
 *
 * Cada chamada de schedule recebe sua própria Promise, resolvida/rejeitada
 * junto com o lote ao qual a mensagem pertence.
 */
export function createInboundMessageScheduler({
  deliver,
  delayMs = 1200,
  isImmediate = job => Boolean(
    job?.nonText || DEFAULT_IMMEDIATE_TYPES.has(String(job?.mediaType || '').toLowerCase())
  ),
  keyOf = job => job?.phone,
  onError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (typeof deliver !== 'function') {
    throw new TypeError('deliver precisa ser uma função');
  }

  const pending = new Map();
  const delay = Math.max(0, Number(delayMs) || 0);

  const reportError = (error, context) => {
    try { onError(error, context); } catch {}
  };

  const runBatch = async batch => {
    const waiters = Array.isArray(batch.waiters) ? batch.waiters : [];
    try {
      const result = await deliver(batch);
      for (const waiter of waiters) waiter.resolve(result);
      return result;
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error);
      throw error;
    }
  };

  const flush = async key => {
    const batch = pending.get(key);
    if (!batch) return null;
    pending.delete(key);
    if (batch.timer) clearTimer(batch.timer);
    batch.timer = null;
    return runBatch(batch);
  };

  const schedule = job => {
    const key = keyOf(job);
    if (key === undefined || key === null || key === '') {
      return Promise.resolve().then(() => deliver(job));
    }

    if (isImmediate(job)) {
      // O lote anterior é inserido na fila por contato antes da mídia.
      // Mesmo quando falha, a mensagem seguinte não deve ser descartada.
      return flush(key)
        .catch(error => reportError(error, { phase: 'flush_before_immediate', job }))
        .then(() => deliver(job));
    }

    return new Promise((resolve, reject) => {
      let batch = pending.get(key);
      if (batch) {
        if (batch.timer) clearTimer(batch.timer);
        batch.text = `${String(batch.text || '')}\n${String(job?.text || '')}`;
        batch.keyId = job?.keyId || batch.keyId;
        batch.waiters.push({ resolve, reject });
      } else {
        batch = { ...job, waiters: [{ resolve, reject }], timer: null };
        pending.set(key, batch);
      }

      batch.timer = setTimer(() => {
        if (pending.get(key) === batch) pending.delete(key);
        batch.timer = null;
        void runBatch(batch).catch(error => reportError(error, { phase: 'debounced_delivery', job: batch }));
      }, delay);
      batch.timer?.unref?.();
    });
  };

  const drain = async () => {
    const keys = [...pending.keys()];
    const results = await Promise.allSettled(keys.map(key => flush(key)));
    return {
      flushed: keys.length,
      failed: results.filter(result => result.status === 'rejected').length
    };
  };

  return {
    schedule,
    flush,
    drain,
    get pendingCount() { return pending.size; }
  };
}
