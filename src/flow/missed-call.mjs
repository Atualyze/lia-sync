import { filterReply } from '../safety.mjs';
import { cleanJidPhone } from '../sessions.mjs';
import { isHumanHandoffActive } from './human-handoff-state.mjs';

const DEFAULT_MISSED_CALL_MSG =
  'Oi! Vi que você tentou ligar agora há pouco e não conseguimos atender. Como posso te ajudar por aqui?';

const pendingTimers = new Map();

function sanitize(text) {
  const filtered = filterReply(String(text || ''), { strictPrices: false });
  return typeof filtered === 'string' ? filtered : (filtered?.text || String(text || ''));
}

export function cancelMissedCall(phone) {
  const key = cleanJidPhone(phone);
  if (!key || !pendingTimers.has(key)) return false;
  clearTimeout(pendingTimers.get(key));
  pendingTimers.delete(key);
  return true;
}

/**
 * Agenda retorno automático no WhatsApp após uma ligação perdida.
 * Se o contato já interagiu antes do timer vencer ou estiver em handoff humano, cancela o envio.
 */
export function scheduleMissedCallTextBack({
  phone,
  callerName = '',
  delaySeconds = 60,
  message = DEFAULT_MISSED_CALL_MSG,
  store = null,
  sendText,
  triggeredAt = Date.now(),
} = {}) {
  const clean = cleanJidPhone(phone);
  if (!clean || !/^\d{8,15}$/.test(clean) || typeof sendText !== 'function') {
    return { scheduled: false, reason: 'invalid_phone_or_sender' };
  }

  const delayMs = Math.max(10, Number(delaySeconds ?? 60) * 1000);
  cancelMissedCall(clean);

  const timer = setTimeout(async () => {
    pendingTimers.delete(clean);
    try {
      const session = store?.get?.(clean);
      if (session) {
        if (isHumanHandoffActive(session)) return;
        const lastActivity = Date.parse(session.updatedAt || '');
        if (Number.isFinite(lastActivity) && lastActivity > triggeredAt) return;
      }

      const greeting = callerName ? `Oi, ${String(callerName).trim()}! ` : '';
      const rawMsg = greeting && !String(message).toLowerCase().startsWith('oi')
        ? `${greeting}${message}`
        : String(message || DEFAULT_MISSED_CALL_MSG);

      const finalMsg = sanitize(rawMsg);
      const target = session?.jid || `${clean}@s.whatsapp.net`;
      await sendText(target, finalMsg);

      if (session) {
        session.missedCallAt = new Date().toISOString();
        session.updatedAt = new Date().toISOString();
        if (!session.funnelStage) session.funnelStage = 'novo';
        store?.markDirty?.();
        await store?.flush?.().catch(() => {});
      }
    } catch (err) {
      console.error('[missed-call] falha ao enviar retorno:', err?.message || err);
    }
  }, delayMs);

  pendingTimers.set(clean, timer);
  return { scheduled: true, phone: clean, delaySeconds: Math.round(delayMs / 1000) };
}
