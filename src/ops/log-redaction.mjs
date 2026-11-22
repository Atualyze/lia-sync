const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|authorization|cookie|service[_-]?role|refresh[_-]?token|access[_-]?token|client[_-]?secret)/i;

const SECRET_VALUE_PATTERNS = [
  // PEM private keys
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // Bearer / Basic authorization headers
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // Common provider API keys (OpenAI, Groq, NVIDIA, Google AI, GitHub, Anthropic, Slack, Supabase JWTs)
  /\b(?:sk-(?:proj-|live-|or-v1-)?[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{25,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
  // JWTs (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Credentials embedded in URLs: https://user:pass@host
  /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
  // Query-string tokens/keys
  /([?&](?:api_?key|token|access_token|key|secret|password|apikey)=)([^&\s]+)/gi
];

export function redactSecrets(input) {
  if (input === null || input === undefined) return '';
  let text = String(input);
  text = text.replace(SECRET_VALUE_PATTERNS[0], '-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----');
  text = text.replace(SECRET_VALUE_PATTERNS[1], (_, scheme) => `${scheme} ${REDACTED}`);
  text = text.replace(SECRET_VALUE_PATTERNS[2], REDACTED);
  text = text.replace(SECRET_VALUE_PATTERNS[3], REDACTED);
  text = text.replace(SECRET_VALUE_PATTERNS[4], (_, proto) => `${proto}${REDACTED}@`);
  text = text.replace(SECRET_VALUE_PATTERNS[5], (_, prefix) => `${prefix}${REDACTED}`);
  return text;
}

export function redactObject(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      code: value.code,
      message: redactSecrets(value.message || '')
    };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => redactObject(item, seen));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && val !== null && val !== undefined && val !== '') {
      out[key] = REDACTED;
    } else {
      out[key] = redactObject(val, seen);
    }
  }
  return out;
}

export function createRedactedLogger(baseLogger = console) {
  const wrap = (fn) => (...args) => {
    if (typeof fn !== 'function') return;
    const safeArgs = args.map(arg => (typeof arg === 'string' ? redactSecrets(arg) : redactObject(arg)));
    fn.apply(baseLogger, safeArgs);
  };
  return {
    log: wrap(baseLogger.log),
    info: wrap(baseLogger.info || baseLogger.log),
    warn: wrap(baseLogger.warn || baseLogger.log),
    error: wrap(baseLogger.error || baseLogger.log)
  };
}
