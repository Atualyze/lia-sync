import { resolveIdentity } from './core/identity.mjs';

export function summary(session, reason = 'solicitação de atendimento', urgency = 'normal', identityInput = {}) {
  const identity = resolveIdentity(identityInput);
  const owner = identity.responsible || 'nossa equipe';
  const last = (session.history || [])
    .slice(-4)
    .map(m => `• ${m.role === 'user' ? (session.clientName || 'Contato') : identity.botName}: "${String(m.content || '').slice(0, 140)}"`)
    .join('\n');

  const clientName = session.clientName || session.contactName || 'Contato';
  const phone = session.phone || '';
  const cleanDigits = phone.replace(/@.*$/, '').replace(/\D/g, '');
  const waLink = cleanDigits ? `https://wa.me/${cleanDigits}` : '—';
  const tagUrgency = urgency === 'emergencia' ? ' 🚨 *URGENTE*' : '';

  return `🔔 *Novo contato para você, ${owner}!*${tagUrgency}\n\n` +
    `👤 *Nome:* ${clientName}\n` +
    `📱 *WhatsApp:* ${waLink}\n` +
    `🎯 *Motivo:* ${reason}\n\n` +
    `💬 *Conversa até agora:*\n${last || '• Nenhuma mensagem anterior'}`;
}

export async function triggerHandoff(session, {
  reason = 'solicitação de atendimento',
  urgency = 'normal',
  lastUserText = '',
  send,
  notify,
  forceNotify = false,
  now = Date.now(),
  identity = {}
} = {}) {
  if (lastUserText) {
    session.history = [...(session.history || []), { role: 'user', content: lastUserText }];
  }

  const wasAlreadyHuman = Boolean(session.human);
  session.human = true;
  session.handoffAt = new Date(now).toISOString();
  session.handoffReason = reason;
  session.handoffUrgency = urgency;

  if (send) await send?.();

  const shouldNotify = notify && (
    forceNotify ||
    !wasAlreadyHuman ||
    !session.handoffNotified ||
    urgency === 'emergencia' ||
    session.humanSource === 'resume'
  );
  if (shouldNotify) {
    try {
      await notify(summary(session, reason, urgency, identity));
      session.handoffNotified = true;
      session.handoffNotifyFailed = false;
      session.lastNotifiedUrgency = urgency;
    } catch (e) {
      session.handoffNotifyFailed = true;
      console.error('[handoff] Falha ao notificar responsável:', e.message);
    }
  }

  session.handoffReminderAt = now + 15 * 60000;
  return session;
}

export { summary as buildHandoffSummary };
