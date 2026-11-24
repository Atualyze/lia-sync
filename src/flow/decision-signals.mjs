import { normalize } from '../safety.mjs';

function normalized(value = '') {
  return normalize(String(value || '')).replace(/\s+/g, ' ').trim();
}

/**
 * Treat a pending operation as approved only for a short, unambiguous
 * confirmation. Extra clauses, questions, objections and changes are not
 * approvals; they must be interpreted as a new conversational turn.
 */
export function isNaturalAffirmation(value = '') {
  const text = normalized(value);
  if (!text || text.length > 48 || /\b(?:mas|porem|antes|duvida|duvidas|nao|cancel|corrige|altera|troca)\b/.test(text)) return false;
  const exact = /^(?:sim|s|ss|pode|pode sim|confirmo|confirmado|confirma|quero|isso|perfeito|fechado|ok|okay|ta bom|vamos|pode agendar|pode marcar|combinado|autorizo|pode seguir|segue|manda ver)[.!]*$/;
  const combined = /^(?:sim|isso|ok|okay|perfeito|pode)[, ]+(?:pode|confirmo|confirmar|agendar|marcar|fechar|seguir|prosseguir|autoriza|autorizar)(?:[, ]+(?:agendar|marcar|agora|sim|por favor))?[.!]*$/;
  return exact.test(text) || combined.test(text);
}

/** A pending operation is declined only by a clear, standalone negative. */
export function isNaturalNegative(value = '') {
  const text = normalized(value);
  if (!text || text.length > 40 || /\b(?:mas|porem|duvida|explica|pergunta|talvez)\b/.test(text)) return false;
  return /^(?:nao|n|cancela|cancelar|deixa|melhor nao|desisti|desistir|nao quero|nao precisa|nao pode|negativo)[.!]*$/.test(text);
}


/** Resolve payment intent from natural phrasing, including colloquial verbs and short replies. */
export function resolvePaymentChoice(value = '') {
  let text = normalized(value);
  if (!text || /\\b(?:o que e|como funciona|me explica|explica|entender|duvida|qual a diferenca|aceita|aceitam|recebe|recebem)\\b/.test(text)) return null;

  const negativeAt = text.search(/\\b(?:nao|nunca|jamais)\\b/);
  if (negativeAt >= 0) {
    const markers = [' mas ', ' porem ', ' prefiro ', ' escolho ', ' vou de '];
    const marker = markers
      .map(value => ({ value, index: text.lastIndexOf(value) }))
      .filter(item => item.index > negativeAt)
      .sort((a, b) => b.index - a.index)[0];
    if (!marker) return null;
    text = text.slice(marker.index + marker.value.length).trim();
  }

  // Modalidade explícita sempre prevalece sobre a palavra genérica "Pix".
  if (/(?:copia(?:r)?(?:\\s+e\\s+cola)?|copia\\s+e\\s+cola|qr\\s*code|qrcode|codigo\\s+pix|br\\s*code)/.test(text)) return 'pix';
  if (/(?:checkout|link\\s+(?:de\\s+)?pagamento|cartao|infinitepay)/.test(text)) return 'checkout';
  if (/(?:so|apenas|somente)\\s+(?:a\\s+)?chave|chave\\s+pix|qual\\s+(?:e\\s+)?a\\s+chave|dados\\s+(?:do|para)\\s+pix/.test(text)) return 'key';

  const asksToSendPix = /\\b(?:manda(?:r)?|envia(?:r)?|passa(?:r)?|me\\s+da|me\\s+fornece(?:r)?|compartilha(?:r)?|informa(?:r)?|envie|mande|passa|me\\s+manda|me\\s+envia)\\b.{0,55}\\b(?:o\\s+)?pix\\b|\\b(?:pix|chave)\\b.{0,45}\\b(?:manda(?:r)?|envia(?:r)?|passa(?:r)?|fornece(?:r)?|compartilha(?:r)?|informa(?:r)?)\\b/.test(text);
  const hasAmount = /(?:r\\$\\s*)?\\b\\d{1,6}(?:[.,]\\d{1,2})?\\s*(?:reais?|conto|contos)?\\b/.test(text);
  if (asksToSendPix && !hasAmount) return 'key';
  if (asksToSendPix && hasAmount) return 'pix';
  if (/^(?:pix|a chave|chave)$/i.test(text)) return null;
  return null;
}

/** Broad action recognition; exact intent is resolved separately from conversational context. */
export function isPixActionRequest(value = '') {
  const text = normalized(value);
  if (!text || /\\b(?:o que e|como funciona|me explica|explica|entender|duvida|qual a diferenca|aceita|aceitam|recebe|recebem)\\b/.test(text)) return false;
  const paymentTerm = /\\b(?:pix|chave|copia|qr\\s*code|qrcode|checkout|infinitepay|pagamento|cobranca|dados\\s+de\\s+pagamento)\\b/;
  const action = /\\b(?:quero|preciso|me\\s+passa|passa|passe|envia|envie|enviar|manda|mande|mandar|gera|gere|gerar|cria|crie|criar|faz|faca|fazer|cobrar|cobranca|pagar|pagamento|informa|informe|informar|fornece|fornecer|compartilha|compartilhar|receber|obter)\\b/;
  return (paymentTerm.test(text) && action.test(text))
    || /\\b(?:so|apenas|somente)\\s+(?:a\\s+)?chave\\b|\\bchave\\s+pix\\b|\\bcopia\\s+e\\s+cola\\b|\\bqr\\s*code\\b|\\bqrcode\\b|\\bdados\\s+(?:do|para)\\s+pix\\b/.test(text);
}
