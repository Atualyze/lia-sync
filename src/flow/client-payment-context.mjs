import { normalize } from '../safety.mjs';
import { normalizePixKey } from '../tools/gerenciar_cobranca_pagamento.mjs';

export function normalizedClientText(value = '') {
  return normalize(String(value || '')).replace(/\s+/g, ' ').trim();
}

export function amountFromText(value = '') {
  const text = String(value || '');
  const match = text.match(/(?:r\$\s*)?(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:reais|real|conto|contos)?/i);
  if (!match) return 0;
  const raw = match[1].includes(',') && match[1].includes('.')
    ? match[1].replace(/\./g, '').replace(',', '.')
    : match[1].replace(',', '.');
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function hasActivePriceContext(currentText = '', history = [], pendingPayment = false) {
  if (pendingPayment) return true;
  const priceTopic = /\b(?:preco|valor|quanto|custa|custam|custo|mensalidade|orcamento|taxa|tarifa|investimento)\b/i;
  if (priceTopic.test(normalizedClientText(currentText))) return true;
  const priorClientMessages = (Array.isArray(history) ? history : []).filter(message => message?.role === 'user');
  const previousClientMessage = priorClientMessages.at(-2);
  return priceTopic.test(normalizedClientText(previousClientMessage?.content || ''));
}

export function isUsablePaymentCredential(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  return !/^(?:suaempresa|seu[_ -]?(?:handle|token|api[_ -]?key)|inserir(?: aqui)?|exemplo|example|placeholder|changeme|configure(?: aqui)?|teste|test)$/i.test(normalized)
    && !/(?:inserir|placeholder|exemplo|suaempresa|changeme|configure).*(?:handle|api|chave|token)?/i.test(normalized);
}

export function paymentChoiceReply({ hasCheckout = false, hasPix = true } = {}) {
  if (hasPix && hasCheckout) {
    return 'Claro! Como você prefere pagar: *só a chave Pix*, *código Pix copia e cola* ou *link de checkout* (Pix e cartão)?';
  }
  if (hasPix) {
    return 'Claro! Você prefere que eu envie *só a chave Pix* ou gere o *código Pix copia e cola*?';
  }
  if (hasCheckout) {
    return 'Claro! Posso gerar o *link de checkout* (Pix ou cartão) para você. Qual é o valor do pagamento?';
  }
  return 'No momento não temos uma opção de pagamento automático ativa por aqui. Vou pedir para a equipe te enviar os dados de pagamento!';
}

export function paymentUnavailableReply({ hasCheckout = false, hasPix = false } = {}) {
  if (!hasPix && !hasCheckout) {
    return 'A chave Pix ainda não está configurada e o checkout também não está ativo neste atendimento. Ainda não gerei o Pix nem outra cobrança; os dados de pagamento precisam ser configurados antes de prosseguir.';
  }
  if (!hasPix) return 'A chave Pix ainda não está configurada neste atendimento. Posso gerar um link de checkout com valor fixo, se você preferir.';
  return 'No momento não consegui disponibilizar essa opção de pagamento. A equipe precisa verificar a configuração antes de prosseguir.';
}

export function formatPixKeyForDisplay(key = '') {
  const s = String(key || '').trim();
  const brPhone = s.match(/^\+55(\d{10,11})$/);
  return brPhone ? brPhone[1] : s;
}

export function directPixKeyReply({ key, owner }) {
  const displayKey = formatPixKeyForDisplay(key);
  return displayKey
    ? '💳 *Chave Pix para pagamento:*' + '\n\n• *Chave:* `' + displayKey + '`\n• *Favorecido:* ' + owner
    : 'No momento a chave Pix ainda não está configurada. Vou pedir para a equipe te enviar por aqui.';
}

export function resolveConfiguredPixKey(botConfig) {
  const configured = String(
    botConfig?.tools?.settings?.gerenciar_cobranca_pagamento?.pixKey ||
    botConfig?.tools?.settings?.gerenciar_cobranca_pagamento?.key ||
    ''
  ).trim();
  if (!configured || /\b(?:inserir|placeholder|exemplo|sua chave)\b|chave\s+pix\s+aqui/i.test(configured)) return '';
  const keyType = botConfig?.tools?.settings?.gerenciar_cobranca_pagamento?.pixKeyType
    || botConfig?.tools?.settings?.gerenciar_cobranca_pagamento?.keyType
    || 'auto';
  return normalizePixKey(configured, keyType);
}

export function formatPixSuccessReply(toolRes, { owner, pixKey = '', includeKey = false, includePaymentUrl = true } = {}) {
  const valorFmt = toolRes.valor ? 'R$ ' + Number(toolRes.valor).toFixed(2).replace('.', ',') : 'Valor livre';
  const displayKey = formatPixKeyForDisplay(pixKey);
  const showKey = Boolean(displayKey && (includeKey || !includePaymentUrl));
  return [
    '💳 *Aqui está seu Pix para pagamento:*',
    '• *Valor:* ' + valorFmt,
    '• *Favorecido:* ' + (toolRes.favorecido || owner),
    showKey ? '• *Chave Pix:* `' + displayKey + '`' : '',
    (includePaymentUrl && toolRes.paymentUrl && toolRes.paymentMethod !== 'pix_copy_paste') ? '• *Link de pagamento:* ' + toolRes.paymentUrl : '',
    toolRes.pixCopiaECola ? '• *Copia e Cola:*\n```' + toolRes.pixCopiaECola + '```' : ''
  ].filter(Boolean).join('\n\n');
}
