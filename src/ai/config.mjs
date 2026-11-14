import { config } from '../config.mjs';
import { failures, opened, PROVIDERS } from './state.mjs';

export function resolveAIConfig(botConfig = {}) {
  const ai = botConfig?.ai || botConfig || {};
  const provider = String(ai.activeProvider || ai.provider || config.defaultProvider || 'gemini').toLowerCase();
  const rawModel = typeof ai.activeModel === 'string' && ai.activeModel.trim()
    ? ai.activeModel.trim()
    : (typeof ai.model === 'string' && ai.model.trim() ? ai.model.trim() : (config.defaultModel || 'gemini-3.8-flash'));
  const fallbackModels = [...new Set((Array.isArray(ai.fallbackModels) ? ai.fallbackModels : [])
    .filter(model => typeof model === 'string')
    .map(model => model.trim())
    .filter(model => model && model !== rawModel))].slice(0, 3);
  return {
    provider: provider || 'gemini',
    model: rawModel || 'gemini-3.8-flash',
    fallbackModels,
    openrouterFreeOnly: ai.openrouterFreeOnly !== false,
    maxOutputTokens: Math.max(2048, Number(ai.maxOutputTokens) || config.aiMaxOutputTokens || 2048),
    structuredOutputs: ai.structuredOutputs === true,
    requireParameters: ai.requireParameters === true
  };
}

export const providers = (botConfig = {}) => {
  const p = resolveAIConfig(botConfig).provider;
  const others = PROVIDERS.filter(x => x !== p && Boolean(available(x)));
  const ordered = [p, ...others].filter(x => PROVIDERS.includes(x) && Boolean(available(x)));
  const now = Date.now();
  return ordered.sort((a, b) => {
    const aOpen = (opened.get(a) || 0) > now;
    const bOpen = (opened.get(b) || 0) > now;
    if (aOpen !== bOpen) return aOpen ? 1 : -1;
    return 0;
  });
};

export const available = provider =>
  provider === 'gemini' ? config.geminiKey :
  provider === 'openrouter' ? config.openrouterKey :
  provider === 'qwen' ? config.qwenKey :
  provider === 'cloudflare' ? (config.cloudflareAccountId && config.cloudflareApiToken) :
  config.openaiKey;

const PROVIDER_PREFIX = /^(gemini|openrouter|qwen|openai|cloudflare):(.*)$/i;

export function parseFallbackModel(value) {
  const raw = String(value || '').trim();
  const explicit = raw.match(PROVIDER_PREFIX);
  if (explicit) return { provider: explicit[1].toLowerCase(), model: explicit[2].trim() };
  if (/^@cf\//i.test(raw)) return { provider: 'cloudflare', model: raw };
  if (/^gemini[-\w.]/i.test(raw)) return { provider: 'gemini', model: raw };
  if (/^(?:gpt-|o[1-9](?:-|$)|chatgpt-)/i.test(raw)) return { provider: 'openai', model: raw };
  if (/^qwen[-/]/i.test(raw)) return { provider: 'qwen', model: raw };
  if (raw === 'openrouter/free' || raw.includes('/') || raw.endsWith(':free')) return { provider: 'openrouter', model: raw };
  return { provider: null, model: raw };
}

export function fallbackModelsForProvider(aiConfig, provider) {
  return (Array.isArray(aiConfig?.fallbackModels) ? aiConfig.fallbackModels : [])
    .map(parseFallbackModel)
    .filter(item => item.provider === provider && item.model)
    .map(item => item.model);
}

export function getCircuitBreakers() {
  const all = ['gemini', 'openrouter', 'qwen', 'openai', 'cloudflare'];
  const res = {};
  const now = Date.now();
  for (const p of all) {
    const isAvail = Boolean(available(p));
    const failCount = failures.get(p) || 0;
    const openUntil = opened.get(p) || 0;
    const isQuarantine = openUntil > now;
    res[p] = {
      configured: isAvail,
      status: !isAvail ? 'nao_configurado' : (isQuarantine ? 'aberto' : (failCount > 0 ? 'degradado' : 'operacional')),
      failures: failCount,
      quarantineSeconds: isQuarantine ? Math.max(0, Math.ceil((openUntil - now) / 1000)) : 0
    };
  }
  return res;
}

export const OPENROUTER_FREE_MODELS = [
  {
    id: 'google/gemma-4-31b:free',
    name: 'Google: Gemma 4 31B (free)',
    provider: 'google',
    category: 'chat',
    recommended: true,
    contextWindow: '262K',
    params: '30.7B densos',
    role: 'Atendimento & Triagem (Recomendado)',
    description: 'Modelo denso multimodal avançado da Google DeepMind. Excelente fluência em português, raciocínio clínico para triagem e obediência a schemas JSON.'
  },
  {
    id: 'google/gemma-4-26b-a4b:free',
    name: 'Google: Gemma 4 26B A4B (free)',
    provider: 'google',
    category: 'chat',
    recommended: true,
    contextWindow: '262K',
    params: '25.2B total (3.8B ativos MoE)',
    role: 'Atendimento Rápido (Baixa Latência)',
    description: 'Mixture-of-Experts ultra ágil com apenas 3.8B parâmetros ativados por token. Latência mínima para respostas instantâneas no WhatsApp.'
  },
  {
    id: 'nvidia/nemotron-3-ultra:free',
    name: 'NVIDIA: Nemotron 3 Ultra (free)',
    provider: 'nvidia',
    category: 'chat',
    recommended: false,
    contextWindow: '1M',
    params: '550B total (55B ativos MoE)',
    role: 'Orquestração & Raciocínio Profundo',
    description: 'Modelo de fronteira híbrido Transformer-Mamba com 1 milhão de tokens de contexto. Forte em planejamento e workflows multi-etapa complexos.'
  },
  {
    id: 'nvidia/nemotron-3-super:free',
    name: 'NVIDIA: Nemotron 3 Super (free)',
    provider: 'nvidia',
    category: 'chat',
    recommended: false,
    contextWindow: '262K',
    params: '120B total (12B ativos MoE)',
    role: 'Adesão a Regras & Políticas',
    description: 'Arquitetura híbrida Mamba-Transformer MoE (12B ativos) com multi-token prediction. Alta precisão em regras de negócio e triagem segura.'
  },
  {
    id: 'poolside/laguna-xs-2.1:free',
    name: 'Poolside: Laguna XS 2.1 (free)',
    provider: 'poolside',
    category: 'chat',
    recommended: false,
    contextWindow: '256K',
    params: '33B FP8',
    role: 'Agente Compacto & Ferramentas',
    description: 'Modelo compacto quantizado em FP8 projetado para agentes e raciocínio com ferramentas.'
  },
  {
    id: 'cohere/north-mini-code:free',
    name: 'Cohere: North Mini Code (free)',
    provider: 'cohere',
    category: 'chat',
    recommended: false,
    contextWindow: '256K',
    params: '30B total (3B ativos MoE)',
    role: 'Agente & Tarefas de Código',
    description: 'MoE compacto da família North da Cohere. Especializado em ferramentas e tarefas de código.'
  },
  {
    id: 'nvidia/nemotron-3-nano-omni:free',
    name: 'NVIDIA: Nemotron 3 Nano Omni (free)',
    provider: 'nvidia',
    category: 'multimodal',
    recommended: false,
    contextWindow: '256K',
    params: '30B total (3B ativos MoE)',
    role: 'Multimodal (Visão & Áudio)',
    description: 'Sub-agente perceptivo multimodal para visão, vídeo e áudio.'
  },
  {
    id: 'nvidia/nemotron-3.5-content-safety:free',
    name: 'NVIDIA: Nemotron 3.5 Content Safety (free)',
    provider: 'nvidia',
    category: 'safety',
    recommended: false,
    contextWindow: '128K',
    params: '4B fine-tuned Gemma-3',
    role: 'Moderação & Guardrails (Não-Chat)',
    description: 'Modelo de segurança que classifica entradas e saídas como seguras/inseguras com justificativa (não gera respostas de atendimento).'
  },
  {
    id: 'nvidia/nemotron-3-embed-1b:free',
    name: 'NVIDIA: Nemotron 3 Embed 1B (free)',
    provider: 'nvidia',
    category: 'embedding',
    recommended: false,
    contextWindow: '33K',
    params: '1B denso',
    role: 'Embedding Vetorial / RAG (Não-Chat)',
    description: 'Modelo de embeddings de texto de alta densidade para busca semântica em base de conhecimento FAQ/RAG (retorna vetores numéricos, não texto).'
  },
  {
    id: 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
    name: 'NVIDIA: Llama Nemotron Embed VL 1B V2 (free)',
    provider: 'nvidia',
    category: 'embedding',
    recommended: false,
    contextWindow: '131K',
    params: '1.7B multimodal',
    role: 'Embedding Multimodal / RAG (Não-Chat)',
    description: 'Gera vetores para busca multimodal em tabelas, infográficos e texto.'
  },
  {
    id: 'nvidia/llama-nemotron-rerank-vl-1b-v2:free',
    name: 'NVIDIA: Llama Nemotron Rerank VL 1B V2 (free)',
    provider: 'nvidia',
    category: 'rerank',
    recommended: false,
    contextWindow: '10K',
    params: '1.7B cross-encoder',
    role: 'Reranker / RAG (Não-Chat)',
    description: 'Reordena documentos mais relevantes em pipelines de busca semântica.'
  }
];

/**
 * Retorna o modelo apropriado para cada provedor.
 * Modelos do Gemini (gemini-*) só são usados no provedor gemini.
 */
export function providerDefaultModel(provider, aiConfig, fixedModel) {
  if (provider === 'openrouter' && aiConfig.openrouterFreeOnly) {
    const candidate = fixedModel || (provider === aiConfig.provider ? aiConfig.model : fallbackModelsForProvider(aiConfig, provider)[0] || '');
    return candidate === 'openrouter/free' || candidate.endsWith(':free') ? candidate : 'openrouter/free';
  }
  if (fixedModel && provider === aiConfig.provider) return fixedModel;
  if (provider === aiConfig.provider) return aiConfig.model;
  const configuredFallback = fallbackModelsForProvider(aiConfig, provider)[0];
  if (configuredFallback) return configuredFallback;
  if (provider === 'openrouter') return 'nvidia/nemotron-3.5-lightning:free';
  if (provider === 'cloudflare') return '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  return '';
}
