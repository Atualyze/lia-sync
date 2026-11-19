import { normalize } from '../safety.mjs';

function normalized(value = '') {
  return normalize(String(value || '')).replace(/\\s+/g, ' ').trim();
}

/**
 * Treat a pending operation as approved only for a short, unambiguous
 * confirmation. Extra clauses, questions, objections and changes are not
 * approvals; they must be interpreted as a new conversational turn.
 */
export function isNaturalAffirmation(value = '') {
  const text = normalized(value);
  if (!text || text.length > 48 || /\\b(?:mas|porem|antes|duvida|duvidas|nao|cancel|corrige|altera|troca)\\b/.test(text)) return false;
  const exact = /^(?:sim|s|ss|pode|pode sim|confirmo|confirmado|confirma|quero|isso|perfeito|fechado|ok|okay|ta bom|vamos|pode agendar|pode marcar|combinado|autorizo|pode seguir|segue|manda ver)[.!]*$/;
  const combined = /^(?:sim|isso|ok|okay|perfeito|pode)[, ]+(?:pode|confirmo|confirmar|agendar|marcar|fechar|seguir|prosseguir|autoriza|autorizar)(?: sim)?[.!]*$/;
  return exact.test(text) || combined.test(text);
}

/** A pending operation is declined only by a clear, standalone negative. */
export function isNaturalNegative(value = '') {
  const text = normalized(value);
  if (!text || text.length > 40 || /\\b(?:mas|porem|duvida|explica|pergunta|talvez)\\b/.test(text)) return false;
  return /^(?:nao|n|cancela|cancelar|deixa|melhor nao|desisti|desistir|nao quero|nao precisa|nao pode|negativo)[.!]*$/.test(text);
}
