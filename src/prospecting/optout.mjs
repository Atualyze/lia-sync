import { normalizePhone } from '../sessions.mjs';

const OPTOUT_PATTERNS = [
  /^\s*(?:pare|parar|sair|cancelar|remover|descadastrar|stop|unsubscribe)\s*[!.]*\s*$/i,
  /\b(?:n[aã]o\s+quero\s+(?:mais\s+)?(?:receber|mensagens?|contato)|pare\s+de\s+(?:me\s+)?(?:mandar|enviar|chamar)|me\s+tire\s+da\s+lista|pode\s+remover\s+meu\s+n[uú]mero|n[aã]o\s+tenho\s+interesse,?\s*pare)\b/i
];

/**
 * Detects explicit WhatsApp opt-out messages ("pare", "sair", "não quero receber", etc.).
 */
export function isOptOutMessage(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 160) return false;
  return OPTOUT_PATTERNS.some(re => re.test(clean));
}

/**
 * Handles an inbound opt-out request: records phone_suppressions via CampaignStore,
 * marks any active prospect lead as opted_out, and returns a plain confirmation message (no emojis).
 */
export async function handleInboundOptOut({ phone, text, campaignStore, prospectStore = null, send = null, jid = null } = {}) {
  if (!isOptOutMessage(text)) return { matched: false };

  const normalized = normalizePhone(phone);
  if (!normalized) return { matched: false };

  let suppressed = false;
  if (campaignStore?.addSuppression) {
    await campaignStore.addSuppression({
      phone: normalized,
      reason: 'Solicitação de opt-out',
      source: 'whatsapp-inbound'
    });
    suppressed = true;
  }

  if (prospectStore?.markOptedOutByPhone) {
    await prospectStore.markOptedOutByPhone(normalized).catch(() => {});
  }

  const reply = 'Entendido. Seu número foi removido da nossa lista e você não receberá novas mensagens automáticas.';
  if (send) {
    await send(jid || normalized, reply).catch(() => {});
  }

  return { matched: true, phone: normalized, suppressed, reply };
}
