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


/** Resolve an explicit payment choice without treating questions or rejected options as selections. */
export function resolvePaymentChoice(value = '') {
  let text = normalized(value);
  if (!text || /\b(?:o que e|como funciona|me explica|explica|entender|duvida|qual a diferenca|aceita|aceitam|recebe|recebem)\b/.test(text)) return null;

  const negativeAt = text.search(/\b(?:nao|nunca|jamais)\b/);
  if (negativeAt >= 0) {
    const markers = [' mas ', ' porem ', ' prefiro ', ' escolho ', ' vou de '];
    const marker = markers
      .map(value => ({ value, index: text.lastIndexOf(value) }))
      .filter(item => item.index > negativeAt)
      .sort((a, b) => b.index - a.index)[0];
    if (!marker) return null;
    text = text.slice(marker.index + marker.value.length).trim();
  }

  if (/(?:so|apenas)\s+(?:a\s+)?chave|chave\s+pix|qual\s+(?:e\s+)?a\s+chave/.test(text)) return 'key';
  if (/(?:copia|copia e cola|copiar|qr code|qrcode|codigo|br code)/.test(text)) return 'pix';
  if (/(?:checkout|link|cartao|infinitepay)/.test(text)) return 'checkout';
  return null;
}

/** A payment topic alone is not an action request; require an action verb or concrete choice. */
export function isPixActionRequest(value = '') {
  const text = normalized(value);
  if (!text || /\b(?:o que e|como funciona|me explica|explica|entender|duvida|qual a diferenca|aceita|aceitam|recebe|recebem)\b/.test(text)) {
    return false;
  }
  const action = /\b(?:quero|preciso|me passa|passa|envia|enviar|manda|mandar|gera|gerar|cria|criar|faz|fazer|cobrar|cobranca|pagar|pagamento|informa|informar)\b/;
  const paymentTerm = /\b(?:pix|chave|copia|qr code|checkout|infinitepay)\b/;
  return (action.test(text) && paymentTerm.test(text))
    || /\b(?:so a chave|apenas a chave|chave pix|copia e cola|qr code|qrcode|checkout infinitepay)\b/.test(text);
}
