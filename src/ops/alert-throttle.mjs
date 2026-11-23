export function createAlertThrottle({ windowMs = 10 * 60_000, now = Date.now, maxKeys = 500 } = {}) {
  const sentAt = new Map();
  const window = Math.max(0, Number(windowMs) || 0);
  const cap = Math.max(10, Number(maxKeys) || 500);
  return {
    allow(key) {
      const name = String(key || '').trim();
      if (!name) return false;
      const current = Number(now());
      if (!Number.isFinite(current)) return false;
      const previous = sentAt.get(name);
      if (Number.isFinite(previous) && current - previous < window) return false;
      sentAt.set(name, current);
      while (sentAt.size > cap) sentAt.delete(sentAt.keys().next().value);
      return true;
    },
    reset(key) { sentAt.delete(String(key || '').trim()); },
    clear() { sentAt.clear(); }
  };
}
