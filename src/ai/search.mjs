import { config } from '../config.mjs';

/**
 * Busca Web e Enriquecimento em tempo real via Google Search do Gemini
 */
export function shouldEnableGoogleSearch(text = '') {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return /(?:cota[cç][aã]o|d[oó]lar|euro|bitcoin|cripto|clima|tempo|previs[aã]o do tempo|previs[aã]o|not[ií]cia|not[ií]cias|manchete|pesquis|pesquise|busque|buscar na web|procurar no google|pesquisar no google|quem [eé]|quem foi|o que [eé]|o que diz|o que significa|di[aá]rio oficial|lei|provimento|cnj|tjsp|tjal|tjce|stf|stj|jurisprud[eê]ncia|notici[aá]rio|mercado financeiro|ibovespa)\b/i.test(lower);
}

export async function searchWebWithGemini(query) {
  if (!config.geminiKey || !query) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${config.geminiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.2
        }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map(p => p.text || '').join('').trim();
    const queries = candidate?.groundingMetadata?.webSearchQueries || [];
    return { text, queries };
  } catch (e) {
    console.error('[ai] searchWebWithGemini erro:', e.message);
    return null;
  }
}
