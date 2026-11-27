// Limitador em memória (janela fixa) para as rotas públicas de pagamento.
// Não substitui o rate limit do proxy; apenas evita abuso trivial quando o app está exposto.
const DEFAULT_LIMIT_PER_MIN = 60;
const MAX_TRACKED_KEYS = 10_000;

function isLoopbackOrPrivate(ip = '') {
  const clean = String(ip || '').replace(/^::ffff:/, '').trim();
  return clean === '127.0.0.1' || clean === '::1' || clean.startsWith('10.') || clean.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(clean);
}

export function clientKeyFor(req, { trustedProxyHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1) } = {}) {
  const remote = String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '').trim();
  const hops = Number.isFinite(trustedProxyHops) ? Math.max(0, Math.floor(trustedProxyHops)) : 0;
  if (hops > 0 && (!remote || isLoopbackOrPrivate(remote))) {
    const parts = String(req?.headers?.['x-forwarded-for'] || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return parts[Math.max(0, parts.length - hops)];
    }
  }
  return remote || 'unknown';
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
