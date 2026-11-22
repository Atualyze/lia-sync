import { OWNER_SELF_KEY } from '../core/identity.mjs';
import { isEmergency } from '../safety.mjs';
import { broadcastBridgeEvent } from './bridge.mjs';

const DEFAULT_MAX_UNANSWERED_AGE_MS = 12 * 3600_000;

/**
 * Avalia ao reativar a Lia (human -> bot) se o cliente ficou sem resposta
 * e envia uma pergunta contextualizada para o chat interno (owner_self).
 */
export function notifyReactivationToInternalChat({ store, session, phone }) {
  if (!store || !session || !Array.isArray(session.history) || !session.history.length) {
    return null;
  }

  const lastMsg = session.history[session.history.length - 1];
  const unanswered = lastMsg?.role === 'user';
  const contactLabel = session.clientName ? `${session.clientName} (${phone})` : String(phone || 'contato');
  const rawSnippet = String(lastMsg?.content || '').replace(/\s+/g, ' ').trim();
  const snippet = rawSnippet.length > 110 ? `${rawSnippet.slice(0, 110)}…` : rawSnippet;

  const message = unanswered
    ? [
        `Reativei o atendimento de *${contactLabel}*, mas a última mensagem do cliente${snippet ? ` ("${snippet}")` : ''} ficou sem resposta (no vácuo).`,
        '',
        'Você vai resolver esse ponto ou posso dar continuidade no processo de qualificação e dúvidas?'
      ].join('\n')
    : [
        `Reativei o atendimento de *${contactLabel}*. Vi que a última mensagem já foi respondida pelo atendimento humano.`,
        '',
        'Posso dar continuidade no processo de qualificação e dúvidas a partir daqui ou você prefere assumir algo mais?'
      ].join('\n');

  const nowIso = new Date().toISOString();
  const selfSession = store.get?.(OWNER_SELF_KEY);
  if (selfSession && Array.isArray(selfSession.history)) {
    selfSession.history.push({ role: 'assistant', content: message, createdAt: nowIso });
    selfSession.pendingReactivation = {
      phone: String(phone || ''),
      contactLabel,
      unanswered,
      snippet,
      createdAt: nowIso
    };
    selfSession.updatedAt = nowIso;
    store.markDirty?.();
  }

  broadcastBridgeEvent('bot_reply', {
    phone: OWNER_SELF_KEY,
    text: message,
    timestamp: Date.now()
  });

  return { unanswered, message };
}

/**
 * Retomada inteligente ao transferir uma conversa de Humano -> Lia:
 * - Se a última mensagem do cliente ficou sem resposta e é recente (<= 12h) e não é emergência,
 *   a Lia responde automaticamente no WhatsApp usando o contexto real da conversa e apenas
 *   informa o responsável no chat interno.
 * - Caso contrário (já respondida pelo humano, antiga ou sem histórico), não incomoda o cliente
 *   e mantém o aviso padrão no chat interno.
 */
export async function triggerSmartReactivationContinuation({
  store,
  session,
  phone,
  flow,
  sendReply,
  now = () => Date.now(),
  maxAgeMs = DEFAULT_MAX_UNANSWERED_AGE_MS,
  logger = console
} = {}) {
  if (!store || !session || session.human || session.archivedAt) {
    return { continued: false, reason: 'session_not_eligible' };
  }
  const history = Array.isArray(session.history) ? session.history : [];
  if (!history.length) {
    return { continued: false, reason: 'empty_history' };
  }
  const lastMsg = history[history.length - 1];
  const lastText = String(lastMsg?.content || lastMsg?.text || '').replace(/\s+/g, ' ').trim();
  const isUnansweredClient = lastMsg?.role === 'user' && lastText.length > 0;
  const lastMsgMs = Date.parse(lastMsg?.createdAt || session.lastUserAt || '');
  const isRecent = !Number.isFinite(lastMsgMs) || (now() - lastMsgMs <= maxAgeMs);

  if (!isUnansweredClient || !isRecent || isEmergency(lastText) || typeof flow?.process !== 'function' || typeof sendReply !== 'function') {
    notifyReactivationToInternalChat({ store, session, phone });
    return {
      continued: false,
      reason: !isUnansweredClient ? 'already_answered' : (!isRecent ? 'stale_message' : (isEmergency(lastText) ? 'emergency_requires_human' : 'delivery_unavailable'))
    };
  }

  const runContinuation = async () => {
    const live = store.get?.(session.phone || phone) || session;
    if (!live || live.human || live.archivedAt) return { continued: false, reason: 'reverted_to_human' };
    const reply = await flow.process({
      phone: live.phone || phone,
      text: lastText,
      origin: 'reactivation_auto',
      nonText: false,
      mediaType: 'text',
      rawItem: { jid: live.rawJid || phone },
      pushName: live.clientName || '',
      messageId: ''
    });
    if (!reply) {
      notifyReactivationToInternalChat({ store, session: live, phone });
      return { continued: false, reason: 'no_reply_generated' };
    }
    await sendReply(live.rawJid || live.phone || phone, reply, live);

    const contactLabel = live.clientName ? `${live.clientName} (${phone})` : String(phone || 'contato');
    const snippet = lastText.length > 90 ? `${lastText.slice(0, 90)}…` : lastText;
    const notice = `✅ Retomei o atendimento de *${contactLabel}* e já respondi à última mensagem ("${snippet}").`;
    const nowIso = new Date(now()).toISOString();
    const selfSession = store.get?.(OWNER_SELF_KEY);
    if (selfSession && Array.isArray(selfSession.history)) {
      selfSession.history.push({ role: 'assistant', content: notice, createdAt: nowIso });
      if (selfSession.pendingReactivation && String(selfSession.pendingReactivation.phone) === String(phone)) {
        selfSession.pendingReactivation = null;
      }
      selfSession.updatedAt = nowIso;
      store.markDirty?.();
    }
    broadcastBridgeEvent('bot_reply', {
      phone: OWNER_SELF_KEY,
      text: notice,
      timestamp: now()
    });
    return { continued: true, reply };
  };

  try {
    if (typeof store.enqueue === 'function') {
      return await store.enqueue(session.phone || phone, runContinuation);
    }
    return await runContinuation();
  } catch (error) {
    logger?.warn?.('[reactivation] falha na continuidade automática:', error?.message || error);
    notifyReactivationToInternalChat({ store, session, phone });
    return { continued: false, reason: 'continuation_error' };
  }
}
