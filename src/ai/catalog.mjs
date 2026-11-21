import { config } from '../config.mjs';
import { getCustomProvider } from './custom-providers.mjs';

const ALLOWED_PROVIDERS = new Set(['gemini', 'groq', 'nvidia', 'openrouter', 'openai', 'qwen', 'cloudflare']);
const CACHE_TTL_MS = 60_000;
const cache = new Map();

function applyFreeFilter(provider, value, freeOnly) {
  if (!freeOnly) return value;
  if (provider === 'openrouter') {
    return { ...value, models: value.models.filter(model => model.id.endsWith(':free') || model.id === 'openrouter/free') };
  }
  if (provider === 'cloudflare') {
    return { ...value, models: value.models.filter(model => model.requireWorkersPaid !== true) };
  }
  return value;
}

function providerConfig(provider) {
  if (provider === 'gemini') return {
    key: config.geminiKey,
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    auth: key => ({ 'x-goog-api-key': key })
  };
  if (provider === 'groq') return {
    key: config.groqKey,
    url: `${config.groqBaseUrl}/models`,
    auth: key => ({ Authorization: `Bearer ${key}` })
  };
  if (provider === 'nvidia') return {
    key: config.nvidiaKey,
    url: `${config.nvidiaBaseUrl}/models`,
    auth: key => ({ Authorization: `Bearer ${key}` })
  };
  if (provider === 'openrouter') return {
    key: config.openrouterKey,
    url: `${config.openrouterBaseUrl}/models`,
    auth: key => ({ Authorization: `Bearer ${key}` })
  };
  if (provider === 'qwen') return {
    key: config.qwenKey,
    url: `${config.qwenBaseUrl}/models`,
    auth: key => ({ Authorization: `Bearer ${key}` })
  };
  if (provider === 'cloudflare') return {
    key: config.cloudflareAccountId && config.cloudflareApiToken ? config.cloudflareApiToken : '',
    url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.cloudflareAccountId || '')}/ai/models/search?task=Text+Generation`,
    auth: key => ({ Authorization: `Bearer ${key}` })
  };
  const custom = getCustomProvider(provider);
  if (custom) return {
    key: custom.enabled ? custom.apiKey : '',
    url: `${custom.baseUrl}/models`,
    auth: key => ({ Authorization: `Bearer ${key}` }),
    custom
  };
  return {
    key: config.openaiKey,
    url: 'https://api.openai.com/v1/models',
    auth: key => ({ Authorization: `Bearer ${key}` })
  };
}

function normalizeModel(provider, model) {
  const id = String(provider === 'gemini' || provider === 'cloudflare' ? model.name || model.id || '' : model.id || '').replace(/^models\//, '').trim();
  if (!id || id.length > 200) return null;
  if (provider !== 'gemini' && /(?:embedding|embed-|text-embedding|whisper|transcri|moderation|dall-e|tts|text-to-speech|rerank|reranker)/i.test(id)) return null;
  if (provider === 'gemini') {
    if (!id.startsWith('gemini-')) return null;
    if (/(?:-tts\b|-image\b|-image-preview\b|nano-banana|transcribe|computer-use|robotics|deep-research|antigravity|lyria|-omni-|customtools|^gemini-4-(?:argon|carbon|hydrogen)$)/i.test(id)) return null;
    if (Array.isArray(model.supportedGenerationMethods) && !model.supportedGenerationMethods.includes('generateContent')) return null;
  }
  const requireWorkersPaid = provider === 'cloudflare' && Array.isArray(model.properties)
    ? model.properties.some(prop => prop?.property_id === 'require_workers_paid' && String(prop?.value).toLowerCase() === 'true')
    : false;
  return {
    id,
    name: String(model.displayName || model.name || model.id || id).replace(/^models\//, '').slice(0, 200),
    provider,
    ownedBy: String(model.owned_by || model.provider || '').slice(0, 100),
    contextWindow: Number(model.context_length || model.contextWindow || model.inputTokenLimit) || null,
    capabilities: Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods.slice(0, 20) : [],
    ...(provider === 'cloudflare' ? { requireWorkersPaid } : {})
  };
}

export async function listProviderModels(provider, { forceRefresh = false, timeoutMs = 10000, freeOnly = false } = {}) {
  const name = String(provider || '').toLowerCase();
  const custom = getCustomProvider(name);
  if (!ALLOWED_PROVIDERS.has(name) && !custom) return { ok: false, provider: name, configured: false, models: [], error: 'provider_not_supported' };
  const cached = cache.get(name);
  if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return { ...applyFreeFilter(name, cached.value, freeOnly), cached: true };

  const settings = providerConfig(name);
  if (!settings.key) return { ok: false, provider: name, configured: false, models: [], error: 'provider_not_configured' };
  const customFallbackResult = () => {
    if (!custom?.defaultModel) return null;
    const value = {
      ok: true,
      provider: name,
      configured: true,
      fetchedAt: new Date().toISOString(),
      models: [{
        id: custom.defaultModel,
        name: custom.defaultModel,
        provider: name,
        ownedBy: custom.name || name,
        contextWindow: null,
        capabilities: []
      }],
      truncated: false
    };
    cache.set(name, { at: Date.now(), value });
    return value;
  };
  const controller = AbortSignal.timeout(Math.max(1000, Math.min(30000, Number(timeoutMs) || 10000)));
  const rows = [];
  let cursor = '';
  let truncated = false;
  try {
    for (let page = 0; page < 10; page++) {
      const pageUrl = new URL(settings.url);
      if (name === 'gemini') pageUrl.searchParams.set('pageSize', '1000');
      if (cursor) pageUrl.searchParams.set(name === 'gemini' ? 'pageToken' : 'after', cursor);
      const response = await fetch(pageUrl, { headers: { accept: 'application/json', ...settings.auth(settings.key) }, signal: controller });
      if (!response.ok) {
        const fallback = customFallbackResult();
        if (fallback) return fallback;
        return { ok: false, provider: name, configured: true, models: [], error: `catalog_http_${response.status}` };
      }
      let data;
      try { data = await response.json(); }
      catch {
        const fallback = customFallbackResult();
        if (fallback) return fallback;
        return { ok: false, provider: name, configured: true, models: [], error: 'catalog_invalid_response' };
      }
      const pageRows = name === 'gemini' ? data.models : (name === 'cloudflare' ? data.result : data.data);
      if (!Array.isArray(pageRows)) {
        const fallback = customFallbackResult();
        if (fallback) return fallback;
        return { ok: false, provider: name, configured: true, models: [], error: 'catalog_invalid_response' };
      }
      rows.push(...pageRows);
      const nextToken = data.nextPageToken || data.next_page_token;
      const hasMore = data.has_more === true && pageRows.length > 0;
      cursor = nextToken || (hasMore && name !== 'gemini' && name !== 'cloudflare' ? String(pageRows.at(-1)?.id || '') : '');
      if (!cursor) break;
      if (page === 9 || rows.length >= 5000) truncated = true;
    }
  } catch (error) {
    const fallback = customFallbackResult();
    if (fallback) return fallback;
    const code = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'catalog_timeout' : 'catalog_unavailable';
    return { ok: false, provider: name, configured: true, models: [], error: code };
  }
  const normalized = rows.map(model => normalizeModel(name, model)).filter(Boolean);
  if (custom?.defaultModel && !normalized.some(m => m.id === custom.defaultModel)) {
    normalized.unshift({
      id: custom.defaultModel,
      name: custom.defaultModel,
      provider: name,
      ownedBy: custom.name || name,
      contextWindow: null,
      capabilities: []
    });
  }
  const models = [...new Map(normalized.map(model => [model.id, model])).values()]
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 500);
  if (normalized.length > 500) truncated = true;
  const value = { ok: true, provider: name, configured: true, fetchedAt: new Date().toISOString(), models, truncated };
  cache.set(name, { at: Date.now(), value });
  return applyFreeFilter(name, value, freeOnly);
}
