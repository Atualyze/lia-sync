const DEFAULT_COOLDOWN_MS = 45_000;
const tracker = new Map();

function keyFor(provider = '', model = '') {
  return `${String(provider || '').toLowerCase()}:${String(model || '').trim().toLowerCase()}`;
}

function getEntry(provider, model) {
  const key = keyFor(provider, model);
  let entry = tracker.get(key);
  if (!entry) {
    entry = {
      provider: String(provider || '').toLowerCase(),
      model: String(model || '').trim(),
      calls: 0,
      tokens: 0,
      rateLimits: 0,
      cooldownUntil: 0,
      lastUsedAt: 0
    };
    tracker.set(key, entry);
  }
  return entry;
}

/**
 * Registra consumo de chamadas e tokens por provedor/modelo.
 */
export function recordFreeTierUsage(provider, model, tokens = 0) {
  if (!provider) return;
  const entry = getEntry(provider, model);
  entry.calls += 1;
  entry.tokens += Math.max(0, Number(tokens) || 0);
  entry.lastUsedAt = Date.now();
}

/**
 * Marca cooldown temporário após HTTP 429 para evitar insistir em cota esgotada.
 */
export function recordFreeTierRateLimit(provider, model, retryAfterMs = 0) {
  if (!provider) return;
  const entry = getEntry(provider, model);
  entry.rateLimits += 1;
  const waitMs = Math.min(300_000, Math.max(5_000, Number(retryAfterMs) || DEFAULT_COOLDOWN_MS));
  entry.cooldownUntil = Math.max(entry.cooldownUntil, Date.now() + waitMs);
}

/**
 * Verifica se o provedor/modelo está em janela de cooldown de cota.
 */
export function isFreeTierInCooldown(provider, model, nowMs = Date.now()) {
  const entry = tracker.get(keyFor(provider, model));
  if (!entry) return false;
  return entry.cooldownUntil > nowMs;
}

/**
 * Retorna snapshot das cotas e cooldowns ativos para observabilidade no painel.
 */
export function getFreeTierQuotaSnapshot(nowMs = Date.now()) {
  return [...tracker.values()].map(entry => ({
    provider: entry.provider,
    model: entry.model,
    calls: entry.calls,
    tokens: entry.tokens,
    rateLimits: entry.rateLimits,
    inCooldown: entry.cooldownUntil > nowMs,
    cooldownRemainingMs: Math.max(0, entry.cooldownUntil - nowMs),
    lastUsedAt: entry.lastUsedAt || null
  }));
}

export function clearFreeTierTracker() {
  tracker.clear();
}
