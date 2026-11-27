import { config } from '../config.mjs';
import { getCustomProvider } from './custom-providers.mjs';

const EMBEDDING_CACHE = new Map();
const MAX_CACHE_ENTRIES = 500;

function setCache(key, vec) {
  if (EMBEDDING_CACHE.has(key)) EMBEDDING_CACHE.delete(key);
  EMBEDDING_CACHE.set(key, vec);
  if (EMBEDDING_CACHE.size > MAX_CACHE_ENTRIES) {
    const firstKey = EMBEDDING_CACHE.keys().next().value;
    if (firstKey !== undefined) EMBEDDING_CACHE.delete(firstKey);
  }
}

export function cosineSimilarity(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = Number(a[i]) || 0;
    const vb = Number(b[i]) || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function resolveEmbeddingTarget(botConfig = {}) {
  const ai = botConfig?.ai || {};
  const enabled = ai.embeddingEnabled === true;
  if (!enabled) return null;

  const rawProvider = String(ai.embeddingProvider || 'auto').trim();
  const provider = rawProvider === 'auto'
    ? (String(ai.activeProvider || '').trim() || (config.openaiKey ? 'openai' : (config.geminiKey ? 'gemini' : '')))
    : rawProvider;
  const model = String(ai.embeddingModel || '').trim() || (provider === 'gemini' ? 'text-embedding-004' : 'text-embedding-3-small');

  const custom = provider ? getCustomProvider(provider) : null;
  if (custom?.baseUrl && custom?.apiKey) {
    return {
      kind: 'openai_compatible',
      provider,
      model,
      url: `${custom.baseUrl.replace(/\/$/, '')}/embeddings`,
      apiKey: custom.apiKey
    };
  }
  if (provider === 'openai' && config.openaiKey) {
    return {
      kind: 'openai_compatible',
      provider,
      model,
      url: 'https://api.openai.com/v1/embeddings',
      apiKey: config.openaiKey
    };
  }
  if (provider === 'openrouter' && config.openrouterKey) {
    return {
      kind: 'openai_compatible',
      provider,
      model,
      url: `${config.openrouterBaseUrl}/embeddings`,
      apiKey: config.openrouterKey
    };
  }
  if (provider === 'gemini' && config.geminiKey) {
    return {
      kind: 'gemini',
      provider,
      model,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent`,
      apiKey: config.geminiKey
    };
  }
  return null;
}

export async function generateEmbedding(text, { botConfig = {}, timeoutMs = 8000 } = {}) {
  const clean = String(text || '').trim().slice(0, 4000);
  if (!clean) return null;
  const target = resolveEmbeddingTarget(botConfig);
  if (!target) return null;

  const cacheKey = `${target.provider}:${target.model}:${clean}`;
  if (EMBEDDING_CACHE.has(cacheKey)) {
    return EMBEDDING_CACHE.get(cacheKey);
  }

  try {
    if (target.kind === 'gemini') {
      const res = await fetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': target.apiKey },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ content: { parts: [{ text: clean }] } })
      });
      if (!res.ok) return null;
      const data = await res.json();
      const vec = data?.embedding?.values;
      if (Array.isArray(vec) && vec.length) {
        setCache(cacheKey, vec);
        return vec;
      }
      return null;
    }

    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${target.apiKey}`
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model: target.model, input: clean })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const vec = data?.data?.[0]?.embedding;
    if (Array.isArray(vec) && vec.length) {
      setCache(cacheKey, vec);
      return vec;
    }
    return null;
  } catch {
    return null;
  }
}

export async function rankByEmbedding(query, items = [], { getText = (x) => String(x || ''), botConfig = {}, topK = 5 } = {}) {
  if (!botConfig?.ai?.embeddingEnabled || !Array.isArray(items) || !items.length) return null;
  const queryVec = await generateEmbedding(query, { botConfig });
  if (!queryVec) return null;

  const scored = [];
  for (const item of items.slice(0, 24)) {
    const vec = await generateEmbedding(getText(item), { botConfig });
    if (!vec) continue;
    scored.push({ item, score: cosineSimilarity(queryVec, vec) });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
