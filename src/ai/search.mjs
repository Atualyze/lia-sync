import { config } from '../config.mjs';

/**
 * Busca Web e Enriquecimento em tempo real via Google Search do Gemini
 */
export function shouldEnableGoogleSearch(text = '') {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return /(?:cota[cç][aã]o|d[oó]lar|euro|bitcoin|cripto|selic|ipca|infla[cç][aã]o|clima|tempo|previs[aã]o do tempo|previs[aã]o|not[ií]cia|not[ií]cias|manchete|pesquis|pesquise|busque|buscar na web|consultar?(?:\s+na)?\s+web|procurar no google|pesquisar no google|na internet|quem [eé]|quem foi|quem ganhou|o que [eé]|o que diz|o que significa|di[aá]rio oficial|lei|provimento|cnj|tjsp|tjal|tjce|stf|stj|jurisprud[eê]ncia|notici[aá]rio|mercado financeiro|ibovespa|feriado|endere[cç]o d[aeo]|cnpj d[aeo])\b/i.test(lower);
}

const SEARCH_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'];

export async function searchWebWithGemini(query, { deadline, timeoutMs = config.aiTimeoutMs } = {}) {
  if (!config.geminiKey || !query) return null;
  let lastError = null;
  for (const model of SEARCH_MODELS) {
    try {
      const remaining = deadline ? deadline - Date.now() : timeoutMs;
      if (remaining <= 0) return { error: { code: 'WEB_SEARCH_TIMEOUT', message: 'Prazo da pesquisa web esgotado antes do início.' } };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.geminiKey
        },
        signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remaining))),
        body: JSON.stringify({
          contents: [{ parts: [{ text: query }] }],
          tools: [{ google_search: {} }],
          generationConfig: {
            temperature: 0.2
          }
        })
      });
      if (!res.ok) {
        const code = res.status === 429 ? 'WEB_SEARCH_RATE_LIMIT' : `WEB_SEARCH_HTTP_${res.status}`;
        lastError = { error: { code, message: `Pesquisa web retornou HTTP ${res.status}.` } };
        if (res.status === 404 || res.status === 400 || res.status >= 500) continue;
        return lastError;
      }
      const data = await res.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.map(p => p.text || '').join('').trim();
      const queries = candidate?.groundingMetadata?.webSearchQueries || [];
      const sources = (candidate?.groundingMetadata?.groundingChunks || [])
        .map(chunk => chunk?.web)
        .filter(source => source?.uri)
        .map(source => ({ title: String(source.title || '').slice(0, 300), uri: String(source.uri).slice(0, 2000) }));
      return { text, queries, sources };
    } catch (e) {
      const code = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'WEB_SEARCH_TIMEOUT' : 'WEB_SEARCH_ERROR';
      console.error('[ai] searchWebWithGemini erro:', code);
      lastError = { error: { code, message: e?.message || 'Falha na pesquisa web.' } };
      if (code === 'WEB_SEARCH_TIMEOUT') return lastError;
    }
  }
  return lastError || { error: { code: 'WEB_SEARCH_ERROR', message: 'Falha na pesquisa web.' } };
}
