/**
 * Roteador Autônomo e Dinâmico de Modelos e Capacidades (Capability & Complexity Model Dispatcher)
 *
 * Princípios:
 * 1. Simplicidade/Saudação/Dúvidas Curtas sem Ferramentas -> Tier Lite (0.4s - 0.8s, Custo Mínimo, thinkingBudget = 0)
 * 2. Ferramentas (Tool Calling), Busca Web, Multimodal, Documentos ou Funil -> Tier Flash (1.0s - 1.8s, thinkingBudget = 0)
 * 3. Copiloto ou Análise Estratégica / Consolidação Profunda -> Tier Pro (Raciocínio Profundo, thinkingBudget dinâmico)
 * 4. Fallback Transparente: Se o modelo selecionado falhar, a Lia cai em cascata para o próximo modelo compatível.
 */

export const MODEL_CAPABILITIES = Object.freeze({
  'gemini-3.5-flash-lite': {
    resolvedModel: 'gemini-2.5-flash-lite',
    tier: 'lite',
    supportsTools: true,
    supportsWebSearch: false,
    supportsVision: true,
    defaultThinkingBudget: 0
  },
  'gemini-2.5-flash-lite': {
    resolvedModel: 'gemini-2.5-flash-lite',
    tier: 'lite',
    supportsTools: true,
    supportsWebSearch: false,
    supportsVision: true,
    defaultThinkingBudget: 0
  },
  'gemini-3.8-flash': {
    resolvedModel: 'gemini-2.5-flash',
    tier: 'flash',
    supportsTools: true,
    supportsWebSearch: true,
    supportsVision: true,
    defaultThinkingBudget: 1024
  },
  'gemini-2.5-flash': {
    resolvedModel: 'gemini-2.5-flash',
    tier: 'flash',
    supportsTools: true,
    supportsWebSearch: true,
    supportsVision: true,
    defaultThinkingBudget: 1024
  },
  'gemini-pro-latest': {
    resolvedModel: 'gemini-2.5-pro',
    tier: 'pro',
    supportsTools: true,
    supportsWebSearch: true,
    supportsVision: true,
    defaultThinkingBudget: 2048
  },
  'gemini-2.5-pro': {
    resolvedModel: 'gemini-2.5-pro',
    tier: 'pro',
    supportsTools: true,
    supportsWebSearch: true,
    supportsVision: true,
    defaultThinkingBudget: 2048
  }
});

const TOOL_INTENT_REGEX = /\b(?:agend\w*|marcar|marque|remarcar|compromisso|reuni[aã]o|hor[aá]rios?\s+livres?|minha\s+agenda|google\s+agenda|lembr\w*|follow-?up|retorno|transfer\w*|financeiro|comercial|suporte|setor|humano|atendente|lead|crm|ficha|cadastr\w*|est[aá]gio|envi(?:e|ar)|mand(?:e|ar)|dispar\w*|grav(?:e|ar)\s+(?:um\s+)?[aá]udio|(?:em|por)\s+[aá]udio|ger(?:e|ar)\s+(?:um\s+)?pdf|or[cç]amento|recibo|proposta|declara[cç][aã]o|boleto|segunda\s+via|pix|pagar|pagamento|checkout|infinitepay|comprovante|planilha|drive|cat[aá]logo|cep|cnpj|status|fila|sa[uú]de|comprar|plano|contrat\w*|cancel\w*|urgente|emerg\w*|reclam\w*)\b/i;

const WEB_SEARCH_INTENT_REGEX = /\b(?:pesquis\w*|busc(?:a|ar)\s+na\s+web|consult(?:a|ar)\s+(?:na\s+)?web|na\s+internet|google|cota[cç][aã]o|d[oó]lar|euro|bitcoin|btc|selic|ipca|infla[cç][aã]o|ibovespa|not[ií]cias?\s+de|previs[aã]o\s+do\s+tempo|clima\s+hoje|feriado|cnpj\s+de|endere[cç]o\s+de|quem\s+(?:é|foi|ganhou)|resultado\s+do\s+jogo)\b/i;

const DEEP_REASONING_REGEX = /(?:planej|estrat|analis|auditor|relat|consolid|compara|dossi|benchmark|rca|raiz|arquitetur|diagn[oó]stico\s+profund)/i;

const DOCUMENT_CONTEXT_REGEX = /\b(?:documento|pdf|anexo|planilha|comprovante|contrato|laudo|receita|extrato)\b/i;

/**
 * Identifica quais capacidades cognitivas/operacionais o turno exige.
 */
export function detectarCapacidadesExigidas({
  userText = '',
  system = '',
  history = [],
  isOwner = false,
  isSuperAgent = false,
  hasAttachments = false
} = {}) {
  const raw = String(userText || '').replace(/<\/?mensagem_do_cliente>/gi, '').trim();
  const sys = String(system || '');
  const caps = new Set();

  if (DEEP_REASONING_REGEX.test(raw) && (isOwner || raw.length > 70)) {
    caps.add('deep_reasoning');
  }
  if (
    hasAttachments ||
    DOCUMENT_CONTEXT_REGEX.test(raw) ||
    sys.includes('[ULTIMO_DOCUMENTO_ANALISADO_NA_SESSAO]') ||
    sys.includes('[UNTRUSTED_KNOWLEDGE_BASE_JSON]')
  ) {
    caps.add('document_context');
  }
  if (WEB_SEARCH_INTENT_REGEX.test(raw) || sys.includes('[UNTRUSTED_WEB_SEARCH_JSON]')) {
    caps.add('web_search');
  }
  if (TOOL_INTENT_REGEX.test(raw)) {
    caps.add('tools');
  }
  if (caps.size === 0) {
    const isGreetingOrAck = /^(?:oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|tudo bom|opa|obrigad[oa]|valeu|sim|n[aã]o|ok|beleza|entendi|show|blz|perfeito)[!.,\s?]*$/i.test(raw);
    if (isGreetingOrAck || raw.length <= 45) {
      caps.add('fast_chat');
    } else if (isSuperAgent || isOwner) {
      caps.add('tools');
    } else {
      caps.add('standard_chat');
    }
  }
  return [...caps];
}

/**
 * Avalia o contexto e as capacidades exigidas para decidir o modelo ideal de IA no turno.
 *
 * @param {Object} params
 * @param {string} params.userText - Mensagem recebida.
 * @param {string} [params.system] - System prompt do turno.
 * @param {Array} [params.history] - Histórico recente de mensagens.
 * @param {boolean} [params.isOwner] - Se o interlocutor é o próprio responsável (Copiloto).
 * @param {boolean} [params.isTauan] - Alias legado de `isOwner`, mantido por compatibilidade.
 * @param {boolean} [params.isSuperAgent] - Se o modo Super Agente com Tool Calling está ativo.
 * @param {boolean} [params.hasAttachments] - Se há anexo multimodal no turno.
 * @param {string} [params.configuredModel] - Modelo padrão publicado no painel.
 * @param {boolean} [params.autoRoutingEnabled] - Se o auto-roteamento híbrido está ativado.
 * @returns {{ model: string, resolvedModel: string, tier: 'lite'|'flash'|'pro'|'custom', capabilities: string[], thinkingBudget: number, reason: string }}
 */
export function decidirModeloPorContexto({
  userText = '',
  system = '',
  history = [],
  isOwner = false,
  isTauan = false,
  isSuperAgent = false,
  hasAttachments = false,
  configuredModel = 'gemini-3.8-flash',
  autoRoutingEnabled = true
} = {}) {
  const ownerMode = Boolean(isOwner || isTauan);
  const clean = String(userText || '').replace(/<\/?mensagem_do_cliente>/gi, '').trim();
  const lower = clean.toLowerCase();
  const capabilities = detectarCapacidadesExigidas({
    userText: clean,
    system,
    history,
    isOwner: ownerMode,
    isSuperAgent,
    hasAttachments
  });

  // Se o auto-roteamento não estiver ativado ou modelo for customizado/OpenRouter, respeita o configurado
  if (!autoRoutingEnabled || configuredModel.includes('/') || configuredModel.startsWith('qwen') || configuredModel.startsWith('gpt')) {
    const capMeta = MODEL_CAPABILITIES[configuredModel];
    return {
      model: configuredModel,
      resolvedModel: capMeta?.resolvedModel || configuredModel,
      tier: 'custom',
      capabilities,
      thinkingBudget: capMeta?.defaultThinkingBudget ?? 0,
      reason: 'Modelo fixo configurado manualmente'
    };
  }

  // 1. CASO COPILOTO DO RESPONSÁVEL
  if (ownerMode) {
    const isDeepReasoning = DEEP_REASONING_REGEX.test(lower) || capabilities.includes('deep_reasoning');
    if (isDeepReasoning) {
      return {
        model: 'gemini-pro-latest',
        resolvedModel: 'gemini-2.5-pro',
        tier: 'pro',
        capabilities,
        thinkingBudget: 2048,
        reason: 'Copiloto: Análise profunda e raciocínio estratégico'
      };
    }
    const flashModel = configuredModel || 'gemini-3.8-flash';
    return {
      model: flashModel,
      resolvedModel: MODEL_CAPABILITIES[flashModel]?.resolvedModel || 'gemini-2.5-flash',
      tier: 'flash',
      capabilities,
      thinkingBudget: 1024,
      reason: 'Copiloto: Interação operacional com raciocínio prévio e ferramentas'
    };
  }

  // 2. CASO EXIGE FERRAMENTAS, BUSCA WEB OU CONTEXTO DE DOCUMENTO (NUNCA CAI NO LITE)
  const needsFullFlashCapabilities =
    capabilities.includes('tools') ||
    capabilities.includes('web_search') ||
    capabilities.includes('document_context') ||
    capabilities.includes('deep_reasoning');

  if (!needsFullFlashCapabilities && capabilities.includes('fast_chat')) {
    return {
      model: 'gemini-3.5-flash-lite',
      resolvedModel: 'gemini-2.5-flash-lite',
      tier: 'lite',
      capabilities,
      thinkingBudget: 0,
      reason: 'Linha de Frente: Saudação ou dúvida breve com latência mínima'
    };
  }

  // 3. CASO SUPER AGENTE COM FERRAMENTAS / BUSCA WEB / CONSULTAS AO CRM / ATENDIMENTO COMPLETO
  if (isSuperAgent || needsFullFlashCapabilities) {
    return {
      model: 'gemini-3.8-flash',
      resolvedModel: 'gemini-2.5-flash',
      tier: 'flash',
      capabilities,
      thinkingBudget: capabilities.includes('deep_reasoning') ? 1536 : 1024,
      reason: 'Super Agente: Raciocínio prévio antes de agir, ferramentas e CRM'
    };
  }

  // 4. Padrão equilibrado (com raciocínio prévio antes de responder)
  const defaultModel = configuredModel || 'gemini-3.8-flash';
  return {
    model: defaultModel,
    resolvedModel: MODEL_CAPABILITIES[defaultModel]?.resolvedModel || 'gemini-2.5-flash',
    tier: 'flash',
    capabilities,
    thinkingBudget: 512,
    reason: 'Atendimento Conversacional Padrão com Thinking'
  };
}

