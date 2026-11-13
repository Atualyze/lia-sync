import { config } from '../config.mjs';

const ALLOWED_PROVIDERS = new Set(['gemini', 'openrouter', 'openai', 'qwen']);
const CACHE_TTL_MS = 60_000;
const cache = new Map();

function providerConfig(provider) {
  if (provider === 'gemini') return {
    key: config.geminiKey,
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    auth: key => ({ 'x-goog-api-key': key })
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
  return {
    key: config.openaiKey,
    url: 'https://api.openai.com/v1/models',
    auth: key => ({ Authorization: `Bearer ${key}` })
  };
}

function normalizeModel(provider, model) {
  const id = String(provider === 'gemini' ? model.name || '' : model.id || '').replace(/^models\//, '').trim();
  if (!id || id.length > 200) return null;
  if (provider !== 'gemini' && /(?:embedding|embed-|text-embedding|whisper|transcri|moderation|dall-e|tts|text-to-speech|rerank|reranker)/i.test(id)) return null;
  if (provider === 'gemini' && Array.isArray(model.supportedGenerationMethods) && !model.supportedGenerationMethods.includes('generateContent')) return null;
  return {
    id,
    name: String(model.displayName || model.name || model.id || id).replace(/^models\//, '').slice(0, 200),
    provider,
    ownedBy: String(model.owned_by || model.provider || '').slice(0, 100),
    contextWindow: Number(model.context_length || model.contextWindow || model.inputTokenLimit) || null,
    capabilities: Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods.slice(0, 20) : []
  };
}

export async function listProviderModels(provider, { forceRefresh = false, timeoutMs = 10000 } = {}) {
  const name = String(provider || '').toLowerCase();
  if (!ALLOWED_PROVIDERS.has(name)) return { ok: false, provider: name, configured: false, models: [], error: 'provider_not_supported' };
  const cached = cache.get(name);
  if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return { ...cached.value, cached: true };

  const settings = providerConfig(name);
  if (!settings.key) return { ok: false, provider: name, configured: false, models: [], error: 'provider_not_configured' };
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
      if (!response.ok) return { ok: false, provider: name, configured: true, models: [], error: `catalog_http_${response.status}` };
      let data;
      try { data = await response.json(); }
      catch { return { ok: false, provider: name, configured: true, models: [], error: 'catalog_invalid_response' }; }
      const pageRows = name === 'gemini' ? data.models : data.data;
      if (!Array.isArray(pageRows)) return { ok: false, provider: name, configured: true, models: [], error: 'catalog_invalid_response' };
      rows.push(...pageRows);
      const nextToken = data.nextPageToken || data.next_page_token;
      const hasMore = data.has_more === true && pageRows.length > 0;
      cursor = nextToken || (hasMore && name !== 'gemini' ? String(pageRows.at(-1)?.id || '') : '');
      if (!cursor) break;
      if (page === 9 || rows.length >= 5000) truncated = true;
    }
  } catch (error) {
    const code = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'catalog_timeout' : 'catalog_unavailable';
    return { ok: false, provider: name, configured: true, models: [], error: code };
  }
  const normalized = rows.map(model => normalizeModel(name, model)).filter(Boolean);
  const models = [...new Map(normalized.map(model => [model.id, model])).values()]
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 500);
  if (normalized.length > 500) truncated = true;
  const value = { ok: true, provider: name, configured: true, fetchedAt: new Date().toISOString(), models, truncated };
  cache.set(name, { at: Date.now(), value });
  return value;
}
