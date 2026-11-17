import { normalizePhone } from '../sessions.mjs';

const OPTOUT_PATTERNS = [
  /^\s*(?:pare|parar|sair|cancelar|remover|descadastrar|stop|unsubscribe|me\s+remove|sai\s+fora)\s*[!.]*\s*$/i,
  /\b(?:n[aã]o\s+quero\s+(?:mais\s+)?(?:receber|mensagens?|contato)|pare\s+de\s+(?:me\s+)?(?:mandar|enviar|chamar)|me\s+tire\s+da\s+lista|pode\s+remover\s+meu\s+n[uú]mero|n[aã]o\s+tenho\s+interesse,?\s*pare|n[aã]o\s+quero\s+mais|para\s+de\s+me\s+mandar)\b/i
];

export function isOptOutMessage(text = '') {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 160) return false;
  return OPTOUT_PATTERNS.some(re => re.test(clean));
}

function hasActiveSession(sessionStore, phone) {
  try {
    if (!sessionStore?.has?.(phone)) return false;
    const session = sessionStore.get(phone);
    return Boolean(session?.human || (session?.history?.length || 0) > 0);
  } catch {
    return true;
  }
}

/** Trata opt-out apenas para leads/campanhas ou contatos sem sessão ativa. */
export async function handleInboundOptOut({ phone, text, campaignStore, prospectStore = null, sessionStore = null, send = null, jid = null } = {}) {
  if (!isOptOutMessage(text)) return { matched: false };
  const normalized = normalizePhone(phone);
  if (!normalized) return { matched: false };

  let isLead = false;
  try { isLead = Boolean(await prospectStore?.hasLeadByPhone?.(normalized)); } catch { return { matched: false, reason: 'lead_lookup_failed' }; }
  if (hasActiveSession(sessionStore, normalized) && !isLead) return { matched: false, reason: 'active_session' };
  if (!campaignStore?.addSuppression && !isLead) return { matched: false, reason: 'no_optout_store' };

  const reply = 'Entendido. Seu número foi removido da nossa lista e você não receberá novas mensagens automáticas.';
  let confirmationSent = false;
  if (send) {
    try { await send(jid || normalized, reply); confirmationSent = true; } catch {}
  }

  let suppressed = false;
  try {
    if (campaignStore?.addSuppression) {
      await campaignStore.addSuppression({ phone: normalized, reason: 'Solicitação de opt-out', source: 'whatsapp-inbound' });
      suppressed = true;
    }
    if (prospectStore?.markOptedOutByPhone) await prospectStore.markOptedOutByPhone(normalized);
  } catch (error) {
    return { matched: true, phone: normalized, suppressed, confirmationSent, reply, persistenceError: error?.message || 'optout_persistence_failed' };
  }
  return { matched: true, phone: normalized, suppressed, confirmationSent, reply };
}
