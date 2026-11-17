// Estado mutável compartilhado do subsistema de IA (circuit breaker por provedor).

export const failures = new Map();
export const opened = new Map();
// Em indisponibilidade do Gemini, Cloudflare costuma responder mais rápido
// que os modelos gratuitos do OpenRouter; OpenRouter permanece como fallback.
export const PROVIDERS = ['gemini', 'cloudflare', 'openrouter', 'qwen', 'openai'];
