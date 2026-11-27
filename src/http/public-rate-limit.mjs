// Limitador em memória (janela fixa) para as rotas públicas de pagamento.
// Não substitui o rate limit do proxy; apenas evita abuso trivial quando o app está exposto.
const DEFAULT_LIMIT_PER_MIN = 60;
const MAX_TRACKED_KEYS = 10_000;

export function clientKeyFor(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.socket?.remoteAddress || 'unknown';
}

export function createPublicRateLimiter({ limitPerMin = DEFAULT_LIMIT_PER_MIN, now = () => Date.now() } = {}) {
  const buckets = new Map();
  return function check(key) {
    const t = now();
    if (buckets.size >= MAX_TRACKED_KEYS) {
      for (const [k, entry] of buckets) if (entry.resetAt <= t) buckets.delete(k);
      if (buckets.size >= MAX_TRACKED_KEYS) buckets.clear();
    }
    const entry = buckets.get(key);
    if (!entry || entry.resetAt <= t) {
      buckets.set(key, { count: 1, resetAt: t + 60_000 });
      return { allowed: true };
    }
    if (entry.count >= limitPerMin) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) };
    }
    entry.count += 1;
    return { allowed: true };
  };
}
