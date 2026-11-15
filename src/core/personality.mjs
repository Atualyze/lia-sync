/**
 * Lia Personality Engine — Camada global e compacta de identidade conversacional,
 * independente do provedor de IA (Gemini, OpenRouter, Cloudflare, OpenAI).
 */

const CLICHE_OPENERS_RE = /^\s*(?:claro|com certeza|entendi|perfeito|ótimo|otimo|certamente|sem problemas)[!.,:\s]/i;
const ROBOTIC_CLOSERS_RE = /(?:posso ajudar em algo mais|como posso ajudar(?: você| hoje)?|estou à disposição para qualquer dúvida)\s*[!?.]*\s*$/i;

/**
 * Gera o bloco compacto (~180 tokens) de personalidade conversacional da Lia.
 * Pode ser personalizado por implantação via `botConfig.personality`.
 */
export function buildPersonalityPrompt({ botName = 'Lia', isOwner = false, botConfig = {} } = {}) {
  const custom = botConfig?.personality || {};
  const maxQuestions = Number.isInteger(custom.maxQuestionsPerTurn) ? custom.maxQuestionsPerTurn : 1;
  const allowHumor = custom.allowHumor !== false;
  const toneNote = typeof custom.tone === 'string' && custom.tone.trim()
    ? `\n- Tom configurado: ${custom.tone.trim()}.`
    : '';

  return `[PERSONALIDADE CONVERSACIONAL — ${String(botName || 'Lia').toUpperCase()}]
Você é ${botName}, uma IA conversacional inteligente, atenciosa e objetiva. Nunca diga ser humana, mas converse com naturalidade real (sem soar como roteiro de suporte).
- Abertura e estilo: varie o início das respostas; evite abrir sempre com "Claro!", "Com certeza!" ou "Entendi!", evite listas quando 2 frases resolvem e não termine toda mensagem com "Posso ajudar em algo mais?".
- Contexto e memória: use o histórico para entender referências ("isso", "aquela opção"), erros de digitação, abreviações, ironia e mudanças de assunto — nunca corrija a escrita do usuário nem pergunte o que ele já informou.
- Ritmo: responda primeiro ao que foi perguntado, adapte o tamanho ao da mensagem recebida e faça no máximo ${maxQuestions} pergunta de esclarecimento por vez.${allowHumor ? ' Humor leve e empático é bem-vindo quando couber.' : ''}
- Empatia e honestidade: se houver frustração, reconheça sem teatralidade e proponha saída prática; nunca invente dados ou finja ter executado uma ferramenta sem tê-la chamado.${isOwner ? ' Com o responsável, seja ágil e direta ao ponto.' : ''}${toneNote}`;
}

/**
 * Calcula temperatura adaptativa para equilibrar naturalidade em conversa livre
 * e precisão estrita em Tool Calling / JSON / Copiloto.
 */
export function resolveAdaptiveTemperature({
  explicitTemperature,
  hasTools = false,
  isJsonResponse = false,
  isOwner = false
} = {}) {
  if (typeof explicitTemperature === 'number' && Number.isFinite(explicitTemperature)) {
    return Math.max(0, Math.min(1.5, explicitTemperature));
  }
  if (hasTools) return 0.25;
  if (isOwner) return 0.35;
  if (isJsonResponse) return 0.58;
  return 0.62;
}

/**
 * Avaliador determinístico de naturalidade (sem custo de tokens).
 * Detecta vícios robóticos comuns para regressão em testes e scripts de eval.
 */
export function evaluateNaturalnessReply(reply, { maxQuestions = 1 } = {}) {
  const text = String(reply || '').trim();
  const issues = [];
  if (!text) {
    return { ok: false, score: 0, issues: ['empty_reply'] };
  }
  if (CLICHE_OPENERS_RE.test(text)) {
    issues.push('cliche_opener');
  }
  if (ROBOTIC_CLOSERS_RE.test(text)) {
    issues.push('robotic_closer');
  }
  const questionCount = (text.match(/\?/g) || []).length;
  if (questionCount > maxQuestions) {
    issues.push(`too_many_questions:${questionCount}`);
  }
  const bulletLines = text.split(/\r?\n/).filter((l) => /^\s*(?:[-*•]|\d+\.)\s+/.test(l)).length;
  if (bulletLines >= 4 && text.length < 320) {
    issues.push(`overused_list:${bulletLines}`);
  }
  const score = Math.max(0, 100 - issues.length * 25);
  return { ok: issues.length === 0, score, issues };
}
