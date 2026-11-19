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
  return { normalized: normalizeCommand(raw), code };
}

const APPROVAL_PATTERN = /^(?:sim|confirmo|confirmado|confirmar|confirm|pode enviar|pode mandar|pode disparar|pode gravar|autorizo|manda|envia|dispara|dispare|vai|ok|okay|isso)(?:\s+(?:agora|ja|mesmo|pode enviar|pode mandar|pode disparar|pode gravar|certo|ta|tudo bem))*$/;
const CANCEL_PATTERN = /^(?:nao|nao precisa|nao precisa mais|nao precisa enviar|nao precisa mandar|nao precisa disparar|nao precisa gravar|nao quero|nao quero mais|nao envia|nao mande|nao manda|nao dispare|nao dispara|nao cancela|nao cancelar|nao aborta|nao abortar|nao esquece|nao desiste|negativo|cancelar|cancela|cancelado|abortar|aborta|esquece|desiste|descarta|cancelar envio|cancela envio|cancelar disparo|cancela disparo|cancelar mensagem|cancela mensagem|cancelar audio|cancela audio|cancelar previa|cancela previa|pode cancelar|pode cancelar envio|pode cancelar o envio|pode cancelar disparo|pode cancelar o disparo|deixa quieto|deixa pra la|deixa envio quieto|deixa a mensagem quieta)$/;
const STRONG_CANCEL_PATTERN = /^(?:cancelar|cancela|cancelado|abortar|aborta|esquece|desiste|descarta|cancelar envio|cancela envio|cancelar disparo|cancela disparo|cancelar mensagem|cancela mensagem|cancelar audio|cancela audio|cancelar previa|cancela previa|pode cancelar|pode cancelar envio|pode cancelar o envio|pode cancelar disparo|pode cancelar o disparo|deixa quieto|deixa pra la|deixa envio quieto|deixa a mensagem quieta)$/;

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
  const { normalized, code } = prepareCommand(value);
  return CANCEL_PATTERN.test(normalized) ? toMatch(normalized, code) : null;
}

export function isExplicitCopilotCancellation(value = '', { hasPending = false } = {}) {
  const { normalized } = prepareCommand(value);
  return STRONG_CANCEL_PATTERN.test(normalized) || (hasPending && CANCEL_PATTERN.test(normalized));
}