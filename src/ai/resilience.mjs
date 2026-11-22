const CAPABILITY_TTL_MS = 6 * 60 * 60 * 1000;
const capabilityCache = new Map();

const REASONING_MODEL_RE = /(?:gpt-oss|qwen3|deepseek|(?:\b|[-_\/])r1(?:\b|[-_])|nemotron|gemma-4|thinking|\bo[134](?:-mini|-preview)?\b)/i;
const JSON_FRAGILE_REASONING_RE = /(?:gpt-oss|qwen3|deepseek|(?:\b|[-_\/])r1(?:\b|[-_])|nemotron|thinking)/i;
const THINKING_TEMPLATE_RE = /(?:nemotron|qwen3|deepseek|thinking)/i;

const PROVIDER_SAFETY_FALLBACKS = Object.freeze({
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  nvidia: ['meta/llama-3.3-70b-instruct'],
  qwen: ['qwen-plus', 'qwen-turbo'],
  openai: ['gpt-4o-mini']
});

function cacheKey(provider = '', model = '') {
  return `${String(provider || '').toLowerCase()}:${String(model || '').trim().toLowerCase()}`;
}

export function clearModelCapabilities() {
  capabilityCache.clear();
}

export function getModelCapabilities(provider = '', model = '') {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').trim();
  const key = cacheKey(p, m);
  const now = Date.now();
  const cached = capabilityCache.get(key);
  const learned = cached && (now - cached.updatedAt < CAPABILITY_TTL_MS) ? cached : {};

  const heuristicReasoning = REASONING_MODEL_RE.test(m) || m === 'openrouter/free';
  const isReasoning = typeof learned.isReasoning === 'boolean' ? learned.isReasoning : heuristicReasoning;
  const heuristicJsonFragile = JSON_FRAGILE_REASONING_RE.test(m) && (p === 'groq' || p === 'nvidia' || p === 'qwen' || p === 'openrouter');
  const supportsResponseFormat = typeof learned.supportsResponseFormat === 'boolean'
    ? learned.supportsResponseFormat
    : !heuristicJsonFragile;
  const supportsNativeTools = typeof learned.supportsNativeTools === 'boolean'
    ? learned.supportsNativeTools
    : true;
  const supportsThinkingToggle = typeof learned.supportsThinkingToggle === 'boolean'
    ? learned.supportsThinkingToggle
    : ((p === 'nvidia' || p === 'qwen') && THINKING_TEMPLATE_RE.test(m));

  return {
    isReasoning,
    supportsResponseFormat,
    supportsNativeTools,
    supportsThinkingToggle
  };
}

export function learnModelCapability(provider = '', model = '', patch = {}) {
  const key = cacheKey(provider, model);
  if (!key || key === ':') return;
  const prev = capabilityCache.get(key) || {};
  capabilityCache.set(key, {
    ...prev,
    ...patch,
    updatedAt: Date.now()
  });
  if (capabilityCache.size > 200) {
    const oldest = capabilityCache.keys().next().value;
    if (oldest) capabilityCache.delete(oldest);
  }
}

export function extractMessageContent(message = {}) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean);
    const joined = parts.join('\n').trim();
    if (joined) return joined;
  }
  if (typeof message.output_text === 'string' && message.output_text.trim()) {
    return message.output_text.trim();
  }
  return '';
}

export function extractJsonFromReasoning(message = {}) {
  const reasoningText = String(message?.reasoning || message?.reasoning_content || '').trim();
  if (!reasoningText) return '';
  const match = reasoningText.match(/\{[\s\S]*"reply"\s*:[\s\S]*\}/);
  return match ? match[0].trim() : '';
}

export function applyReasoningControls(body = {}, { provider = '', model = '', caps = null } = {}) {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').trim();
  const resolved = caps || getModelCapabilities(p, m);
  if (!resolved.isReasoning) return body;

  const out = { ...body };
  if (p === 'groq' && /gpt-oss/i.test(m)) {
    out.reasoning_effort = 'low';
  } else if (p === 'openai' && /\bo[134]/i.test(m)) {
    out.reasoning_effort = 'low';
  } else if (p === 'openrouter') {
    out.reasoning = { effort: 'low' };
  } else if (resolved.supportsThinkingToggle) {
    out.chat_template_kwargs = { enable_thinking: false };
  }
  return out;
}

export function buildProviderCandidateModels({
  provider = '',
  primaryModel = '',
  configuredFallbacks = [],
  customFallbacks = [],
  openrouterFreeOnly = false,
  maxCandidates = 4
} = {}) {
  const p = String(provider || '').toLowerCase();
  const safeConfigured = p === 'openrouter' && openrouterFreeOnly
    ? configuredFallbacks.filter(m => m === 'openrouter/free' || String(m || '').endsWith(':free'))
    : configuredFallbacks;
  const safetyNet = PROVIDER_SAFETY_FALLBACKS[p] || [];
  const all = [
    primaryModel,
    ...(Array.isArray(safeConfigured) ? safeConfigured : []),
    ...(Array.isArray(customFallbacks) ? customFallbacks : []),
    ...safetyNet
  ]
    .map(m => (typeof m === 'string' ? m.trim() : ''))
    .filter(Boolean);
  return [...new Set(all)].slice(0, maxCandidates);
}

export function computeAttemptTimeoutMs({
  remainingMs = 30000,
  providerTimeoutMs = 30000,
  hasMoreCandidates = false
} = {}) {
  const safeRemaining = Math.max(100, Number(remainingMs) || 30000);
  const safeProvider = Math.max(1000, Number(providerTimeoutMs) || 30000);
  const cap = hasMoreCandidates ? Math.min(safeProvider, 15000) : safeProvider;
  return Math.max(100, Math.min(cap, safeRemaining));
}
