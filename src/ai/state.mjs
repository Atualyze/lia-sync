// Estado mutável compartilhado do subsistema de IA (circuit breaker por provedor).

export const failures = new Map();
export const opened = new Map();
export const PROVIDERS = ['gemini', 'openrouter', 'qwen', 'openai', 'cloudflare'];
