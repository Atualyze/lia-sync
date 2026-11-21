import path from 'node:path';

const bool = (name, fallback = false) => process.env[name] === undefined ? fallback : process.env[name] === 'true';
const num = (name, fallback) => Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback;
const bindHost = process.env.HOST || '0.0.0.0';
const loopbackHost = bindHost === 'localhost' || bindHost === '::1' || /^127\./.test(bindHost);

export const config = {
  port: num('PORT', 3000),
  host: bindHost,
  whatsappProvider: (process.env.WHATSAPP_PROVIDER || 'evolution').toLowerCase(),
  baileysAuthDir: path.resolve(process.env.BAILEYS_AUTH_DIR || './data/baileys-auth'),
  evolutionUrl: (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''),
  evolutionKey: process.env.EVOLUTION_API_KEY || '',
  evolutionInstance: process.env.EVOLUTION_INSTANCE || '',
  webhookToken: process.env.WEBHOOK_TOKEN || '',
  allowInsecureWebhook: bool('ALLOW_INSECURE_WEBHOOK') && process.env.NODE_ENV !== 'production' && loopbackHost,
  aiMaxOutputTokens: Math.max(1024, num('AI_MAX_OUTPUT_TOKENS', 1024)),
  aiTimeoutMs: num('AI_TIMEOUT_MS', 30000),
  geminiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  geminiFreeKey: process.env.GEMINI_FREE_API_KEY || '',
  geminiThinkingBudget: num('GEMINI_THINKING_BUDGET', 0),
  groqKey: process.env.GROQ_API_KEY || '',
  openrouterKey: process.env.OPENROUTER_API_KEY || '',
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
  openrouterSiteUrl: process.env.OPENROUTER_SITE_URL || '',
  openrouterAppName: process.env.OPENROUTER_APP_NAME || 'Lia Sync',
  qwenKey: process.env.QWEN_API_KEY || '',
  qwenBaseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
  openaiKey: process.env.OPENAI_API_KEY || '',
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN || '',
  dataFile: path.resolve(process.env.DATA_FILE || './data/sessions.json'),
  maxHistory: num('MAX_HISTORY_MESSAGES', 12),
  maxInputChars: num('MAX_INPUT_CHARS', 2000),
  // Aguarda apenas o suficiente para juntar mensagens enviadas em sequência,
  // sem acrescentar 3 s de latência a toda conversa.
  debounceMs: num('MESSAGE_DEBOUNCE_MS', 1200),
  rateLimitMax: num('RATE_LIMIT_MAX', 20),
  rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MIN', 10) * 60000,
  sessionTtlMs: num('SESSION_TTL_DAYS', 30) * 86400000,
  humanReminderMinutes: num('HANDOFF_REMINDER_MINUTES', 15),
  humanAutoResumeHours: num('HUMAN_AUTO_RESUME_HOURS', 0),
  humanAllowClientResume: bool('HUMAN_ALLOW_CLIENT_RESUME', true),
  businessTimeZone: process.env.BUSINESS_TIME_ZONE || 'America/Sao_Paulo',
  inactivityStaleHours: num('INACTIVITY_STALE_HOURS', 12),
  inactivityCheckSeconds: num('INACTIVITY_CHECK_SECONDS', 30),
  dashboardOrigin: process.env.DASHBOARD_ORIGIN || '',
  chatwootInternalUrl: process.env.CHATWOOT_INTERNAL_URL || 'http://chatwoot-lia:4000',
  // Retained for compatibility with older clients; unauthenticated access is disabled.
  allowUnauthenticatedDashboard: false,
  dashboardRoles: (process.env.DASHBOARD_ALLOWED_ROLES || '').split(',').map(s => s.trim()).filter(Boolean),
  supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseRuntimeEnabled: bool('SUPABASE_RUNTIME_ENABLED', true),
  supabaseCaptchaSiteKey: process.env.SUPABASE_CAPTCHA_SITE_KEY || '',
  supabaseCaptchaProvider: (process.env.SUPABASE_CAPTCHA_PROVIDER || 'turnstile').toLowerCase(),
  faqUrl: process.env.FAQ_URL || '',
  faqCacheSeconds: num('FAQ_CACHE_SECONDS', 60),
  apiV1Keys: Object.freeze((process.env.LIA_API_KEYS || process.env.LIA_API_KEY || '').split(',').map(s => s.trim()).filter(Boolean)),
  apiV1RateLimitPerMin: Math.max(10, num('API_V1_RATE_LIMIT_PER_MIN', 60)),
  publicDir: path.resolve('./public')
};

export function validateConfig({ strict = false } = {}) {
  const errors = [];
  const isBaileys = config.whatsappProvider === 'baileys';
  if (!isBaileys && !config.evolutionInstance) errors.push('EVOLUTION_INSTANCE não configurada');
  if (!config.webhookToken && !config.allowInsecureWebhook) errors.push('WEBHOOK_TOKEN não configurado (use ALLOW_INSECURE_WEBHOOK=true apenas em desenvolvimento)');
  if (strict && !isBaileys && !config.evolutionUrl) errors.push('EVOLUTION_API_URL não configurada');
  return errors;
}

export const BUSINESS = {
  name: 'Lia Atendimento',
  responsible: 'Equipe de Atendimento',
  areas: 'Atendimento Online / Brasil',
  hours: 'segunda a sexta, das 09h às 18h'
};
