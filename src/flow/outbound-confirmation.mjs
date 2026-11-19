const APPROVAL_PATTERN = /^(?:sim|confirmo|confirmado|confirmar|confirm|pode\s+(?:enviar|mandar|disparar|gravar)|autorizo|manda|envia|dispara|dispare|vai|ok|okay|isso)(?:\s+([A-F0-9]{8}))?(?:[\s,;:!?.]+(?:agora|j[áa]|mesmo|por\s+favor|pfv|obrigad[oa]|valeu|t[áa]|certo|tudo\s+bem|pode\s+(?:enviar|mandar|gravar|disparar)))*[\s,;:!?.]*$/i;

const CANCEL_PATTERN = /^(?:(?:n[ãa]o|nao)(?:\s+(?:precisa(?:\s+(?:mais|enviar|mandar|disparar|gravar))?|quero(?:\s+(?:mais|enviar|mandar|disparar|gravar))?|envia|mande|manda|dispare|dispara))?|negativo|(?:n[ãa]o|nao)[\s,;:]+(?:cancela(?:r)?|cancelar|aborta(?:r)?|esquece|desiste|descarta)|(?:pode\s+)?(?:cancelar|cancela(?:r)?|cancelado|abortar|aborta|esquece|desiste|descarta)(?:\s+(?:(?:o|a|esse|essa|este|esta)\s+)?(?:envio|disparo|mensagem|[aá]udio|pr[eé]via))?|deixa\s+(?:(?:(?:o|a|esse|essa|este|esta)\s+)?(?:envio|disparo|mensagem|[aá]udio|pr[eé]via)\s+)?(?:quieto|pra\s+l[áa]))(?:\s+([A-F0-9]{8}))?(?:[\s,;:!?.]+(?:por\s+favor|pfv|obrigad[oa]|valeu))*[\s,;:!?.]*$/i;

const STRONG_CANCEL_PATTERN = /^(?:(?:pode\s+)?(?:cancelar|cancela(?:r)?|cancelado|abortar|aborta|esquece|desiste|descarta)(?:\s+(?:(?:o|a|esse|essa|este|esta)\s+)?(?:envio|disparo|mensagem|[aá]udio|pr[eé]via))?|deixa\s+(?:(?:(?:o|a|esse|essa|este|esta)\s+)?(?:envio|disparo|mensagem|[aá]udio|pr[eé]via)\s+)?(?:quieto|pra\s+l[áa]))(?:[\s,;:!?.]+(?:por\s+favor|pfv|obrigad[oa]|valeu))*[\s,;:!?.]*$/i;

export function matchOutboundApproval(value = '') {
  return String(value || '').trim().match(APPROVAL_PATTERN);
}

export function matchOutboundCancellation(value = '') {
  return String(value || '').trim().match(CANCEL_PATTERN);
}

export function isExplicitCopilotCancellation(value = '', { hasPending = false } = {}) {
  const command = String(value || '').trim();
  return STRONG_CANCEL_PATTERN.test(command) || (hasPending && CANCEL_PATTERN.test(command));
}
