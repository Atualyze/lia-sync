/**
 * Roteador Autônomo e Dinâmico de Modelos (Complexity-Based Model Dispatcher)
 *
 * Princípios:
 * 1. Simplicidade/Saudação/Dúvidas Curtas -> Gemini 3.5 Flash Lite (0.4s - 0.8s, Custo Mínimo)
 * 2. Ferramentas (Tool Calling), Multimodal ou Funil -> Gemini 3.8 Flash (1.2s - 1.8s)
 * 3. Copiloto do responsável em Planejamento / Análise Profunda -> Gemini Pro / 3.8 Flash
 * 4. Fallback Transparente: Se o modelo selecionado falhar, a Lia cai em cascata para o próximo.
 */

/**
 * Avalia o contexto da mensagem e decide o modelo ideal de IA para o turno.
 *
 * @param {Object} params
 * @param {string} params.userText - Mensagem recebida.
 * @param {Array} params.history - Histórico recente de mensagens.
 * @param {boolean} params.isOwner - Se o interlocutor é o próprio responsável (Copiloto).
 * @param {boolean} params.isTauan - Alias legado de `isOwner`, mantido por compatibilidade.
 * @param {boolean} params.isSuperAgent - Se o modo Super Agente com Tool Calling está ativo.
 * @param {string} params.configuredModel - Modelo padrão publicado no painel.
 * @param {boolean} params.autoRoutingEnabled - Se o auto-roteamento híbrido está ativado.
 * @returns {{ model: string, tier: 'lite'|'flash'|'pro'|'custom', reason: string }}
 */
export function decidirModeloPorContexto({
  userText = '',
  history = [],
  isOwner = false,
  isTauan = false,
  isSuperAgent = false,
  configuredModel = 'gemini-3.8-flash',
  autoRoutingEnabled = true
} = {}) {
  // Se o auto-roteamento não estiver ativado ou modelo for customizado/OpenRouter, respeita o configurado
  if (!autoRoutingEnabled || configuredModel.includes('/') || configuredModel.startsWith('qwen') || configuredModel.startsWith('gpt')) {
    return {
      model: configuredModel,
      tier: 'custom',
      reason: 'Modelo fixo configurado manualmente'
    };
  }

  const clean = String(userText || '').trim();
  const lower = clean.toLowerCase();

  // 1. CASO COPILOTO DO RESPONSÁVEL
  if (isOwner || isTauan) {
    const isDeepReasoning = /(?:planej|estrat|analis|auditor|relat|consolid|compara|dossi|benchmark|rca|raiz|arquitetur)/i.test(lower);
    if (isDeepReasoning) {
      return {
        model: 'gemini-pro-latest',
        tier: 'pro',
        reason: 'Copiloto: Análise profunda e raciocínio estratégico'
      };
    }
    return {
      model: configuredModel || 'gemini-3.8-flash',
      tier: 'flash',
      reason: 'Copiloto: Interação operacional dinâmica'
    };
  }

  // 2. CASO MENSAGEM SIMPLES / SAUDAÇÃO / CONFIRMAÇÃO (ROTEIA PARA FLASH-LITE)
  // Menos de 40 caracteres, saudações clássicas, ou confirmações diretas
  const isGreetingOrAck = /^(?:oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|tudo bom|opa|obrigad[oa]|valeu|sim|n[aã]o|ok|beleza|entendi|show|blz|perfeito)[!.,\s?]*$/i.test(lower);
  const isShortFaqQuestion =
    clean.length <= 45 &&
    !/(?:agend|transfer|comprar|plano|contrat|cancel|urgente|emerg|reclam|proposta)/i.test(lower);

  if (isGreetingOrAck || isShortFaqQuestion) {
    return {
      model: 'gemini-3.5-flash-lite',
      tier: 'lite',
      reason: 'Linha de Frente: Saudação ou dúvida breve com latência mínima'
    };
  }

  // 4. CASO SUPER AGENTE COM FERRAMENTAS / CONSULTAS AO CRM / ATENDIMENTO COMPLETO
  if (isSuperAgent || /(?:agend|transfer|reuni[aã]o|hor[aá]rio|lead|interess|proposta|contrat|boleto|segunda via|setor)/i.test(lower)) {
    return {
      model: 'gemini-3.8-flash',
      tier: 'flash',
      reason: 'Super Agente: Execução de ferramentas e persistência no CRM'
    };
  }

  // Padrão equilibrado
  return {
    model: configuredModel || 'gemini-3.8-flash',
    tier: 'flash',
    reason: 'Atendimento Conversacional Padrão'
  };
}
