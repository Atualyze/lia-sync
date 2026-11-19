function normalizeCommand(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[,.!?;:()[\]-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function prepareCommand(value = '') {
  let raw = String(value || '').trim();
  let code = '';
  const codeMatch = raw.match(/(?:^|\s)([A-F0-9]{8})\s*[.!?]*$/i);
  if (codeMatch) {
    code = codeMatch[1].toUpperCase();
    raw = raw.slice(0, codeMatch.index).trim();
  }
  raw = raw.replace(/(?:[\s,;:]+(?:por favor|pfv|obrigad[oa]|valeu))+[.!?]*$/i, '').trim();
  const correctionCancel = /^(?:n[ãa]o|nao)\s*[,;:]\s*(?:pode\s+)?(?:cancela(?:r)?|cancelar|aborta(?:r)?|abortar|esquece|desiste|descarta)(?:\s+(?:(?:o|a|esse|essa|este|esta)\s+)?(?:isso|envio|disparo|mensagem|[aá]udio|pr[eé]via))?[.!?]*$/i.test(raw);
  return { normalized: normalizeCommand(raw), code, correctionCancel };
}

const APPROVAL_PATTERN = /^(?:sim|confirmo|confirmado|confirmar|confirm|pode enviar|pode mandar|pode disparar|pode gravar|autorizo|manda|envia|dispara|dispare|vai|ok|okay|isso)(?:\s+(?:agora|ja|mesmo|pode enviar|pode mandar|pode disparar|pode gravar|manda|envia|dispara|dispare|autorizo|vai|certo|ta|tudo bem))*$/;
const CANCEL_PATTERN = /^(?:nao|nao precisa|nao precisa mais|nao precisa enviar|nao precisa mandar|nao precisa disparar|nao precisa gravar|nao quero|nao quero mais|nao envia|nao mande|nao manda|nao dispare|nao dispara|negativo|cancelar|cancela|cancelado|abortar|aborta|esquece|desiste|descarta|cancelar isso|cancela isso|cancelar envio|cancela envio|cancelar o envio|cancela o envio|cancelar esse envio|cancela esse envio|cancelar disparo|cancela disparo|cancelar o disparo|cancela o disparo|cancelar mensagem|cancela mensagem|cancelar a mensagem|cancela a mensagem|cancelar essa mensagem|cancela essa mensagem|cancelar audio|cancela audio|cancelar o audio|cancela o audio|cancelar previa|cancela previa|cancelar a previa|cancela a previa|pode cancelar|pode cancelar envio|pode cancelar o envio|pode cancelar disparo|pode cancelar o disparo|deixa quieto|deixa pra la|deixa isso pra la|deixa envio quieto|deixa a mensagem quieta)$/;
const STRONG_CANCEL_PATTERN = /^(?:cancelar|cancela|cancelado|abortar|aborta|esquece|desiste|descarta|cancelar isso|cancela isso|cancelar envio|cancela envio|cancelar o envio|cancela o envio|cancelar esse envio|cancela esse envio|cancelar disparo|cancela disparo|cancelar o disparo|cancela o disparo|cancelar mensagem|cancela mensagem|cancelar a mensagem|cancela a mensagem|cancelar essa mensagem|cancela essa mensagem|cancelar audio|cancela audio|cancelar o audio|cancela o audio|cancelar previa|cancela previa|cancelar a previa|cancela a previa|pode cancelar|pode cancelar envio|pode cancelar o envio|pode cancelar disparo|pode cancelar o disparo|deixa quieto|deixa pra la|deixa isso pra la|deixa envio quieto|deixa a mensagem quieta)$/;

function toMatch(normalized, code) {
  const result = [normalized];
  if (code) result[1] = code;
  return result;
}

export function matchOutboundApproval(value = '') {
  const { normalized, code } = prepareCommand(value);
  return APPROVAL_PATTERN.test(normalized) ? toMatch(normalized, code) : null;
}

export function matchOutboundCancellation(value = '') {
  const { normalized, code, correctionCancel } = prepareCommand(value);
  return correctionCancel || CANCEL_PATTERN.test(normalized) ? toMatch(normalized, code) : null;
}

export function isExplicitCopilotCancellation(value = '', { hasPending = false } = {}) {
  const { normalized, correctionCancel } = prepareCommand(value);
  return STRONG_CANCEL_PATTERN.test(normalized) || (hasPending && (correctionCancel || CANCEL_PATTERN.test(normalized)));
}
