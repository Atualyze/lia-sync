// Estado mutável compartilhado do subsistema de IA (circuit breaker por provedor).

export const failures = new Map();
export const opened = new Map();
export const lastErrors = new Map();
// Em indisponibilidade do Gemini, Cloudflare costuma responder mais rápido
// que os modelos gratuitos do OpenRouter; OpenRouter permanece como fallback.
export const PROVIDERS = ['gemini', 'groq', 'nvidia', 'cloudflare', 'openrouter', 'qwen', 'openai'];

/**
 * Extrai o tempo real de espera (ms) de respostas 429 a partir do header
 * HTTP `Retry-After` ou de mensagens de provedores (ex.: Groq "try again in 14.5s", "2m30s").
 */
export function parseRetryAfterMs(headers = null, errorText = '') {
  const clamp = ms => Math.max(2_000, Math.min(300_000, Math.ceil(ms)));
  const headerVal = typeof headers?.get === 'function'
    ? (headers.get('retry-after') || headers.get('x-ratelimit-reset-requests') || headers.get('x-ratelimit-reset-tokens') || '')
    : '';
  const rawHeader = String(headerVal || '').trim();
  if (rawHeader) {
    if (/^\d+(?:\.\d+)?$/.test(rawHeader)) {
      return clamp(Number(rawHeader) * 1000);
    }
    const minSec = rawHeader.match(/(?:(\d+)m)?\s*(\d+(?:\.\d+)?)s/i);
    if (minSec) {
      return clamp(((Number(minSec[1] || 0) * 60) + Number(minSec[2] || 0)) * 1000);
    }
    const dateMs = Date.parse(rawHeader);
    if (Number.isFinite(dateMs) && dateMs > Date.now()) {
      return clamp(dateMs - Date.now());
    }
  }
  const text = String(errorText || '');
  const minSecMsg = text.match(/try\s+again\s+in\s+(?:(\d+)m)?\s*(\d+(?:\.\d+)?)s/i);
  if (minSecMsg) {
    return clamp(((Number(minSecMsg[1] || 0) * 60) + Number(minSecMsg[2] || 0)) * 1000);
  }
  const msMsg = text.match(/try\s+again\s+in\s+(\d+)\s*ms/i);
  if (msMsg) {
    return clamp(Number(msMsg[1]));
  }
  return null;
}

/**
 * Retorna o menor tempo restante (ms) até um provedor em quarentena voltar a ficar disponível.
 */
export function getNextProviderRecoveryDelayMs(nowMs = Date.now()) {
  let minDelay = null;
  for (const until of opened.values()) {
    const remaining = Number(until) - nowMs;
    if (remaining > 0 && (minDelay === null || remaining < minDelay)) {
      minDelay = remaining;
    }
  }
  return minDelay;
}
