import { searchWebWithGemini } from '../ai/search.mjs';

const MAX_QUERY_CHARS = 500;
const MAX_TEXT_CHARS = 12000;

/**
 * Tool: consultar_web
 * Consulta a web via Google Search grounding do Gemini.
 * O retorno é intencionalmente estruturado para ser tratado como dado não confiável.
 */
export const toolConsultarWeb = {
  name: 'consultar_web',
  description: 'Pesquisa informações atuais na web usando o Google Search do Gemini e retorna síntese, consultas usadas e fontes para conferência.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description: 'Pergunta ou consulta objetiva para pesquisar na web.'
      }
    },
    required: ['query']
  },
  async execute({ query } = {}, context = {}) {
    const normalizedQuery = String(query || '').trim().slice(0, MAX_QUERY_CHARS);
    if (!normalizedQuery) {
      return { success: false, error: { code: 'INVALID_QUERY', message: 'A consulta web não pode ficar vazia.' } };
    }

    try {
      const search = context.searchWebWithGemini || searchWebWithGemini;
      const result = await search(normalizedQuery, {
        deadline: context.deadline,
        timeoutMs: context.timeoutMs
      });
      if (!result) {
        return {
          success: false,
          query: normalizedQuery,
          error: { code: 'WEB_SEARCH_UNAVAILABLE', message: 'A pesquisa web não está disponível no momento.' }
        };
      }
      if (result.error) {
        return { success: false, query: normalizedQuery, ...result };
      }
      return {
        success: true,
        query: normalizedQuery,
        text: String(result.text || '').slice(0, MAX_TEXT_CHARS),
        queries: Array.isArray(result.queries) ? result.queries.slice(0, 10) : [],
        sources: Array.isArray(result.sources) ? result.sources.slice(0, 10) : []
      };
    } catch (error) {
      return {
        success: false,
        query: normalizedQuery,
        error: {
          code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'WEB_SEARCH_TIMEOUT' : 'WEB_SEARCH_ERROR',
          message: error?.message || 'Falha desconhecida na pesquisa web.'
        }
      };
    }
  }
};
