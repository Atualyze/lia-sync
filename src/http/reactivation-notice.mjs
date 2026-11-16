import { OWNER_SELF_KEY } from '../core/identity.mjs';
import { broadcastBridgeEvent } from './bridge.mjs';

/**
 * Avalia ao reativar a Lia (human -> bot) se o cliente ficou sem resposta
 * e envia uma pergunta contextualizada para o chat interno (tauan_self).
 */
export function notifyReactivationToInternalChat({ store, session, phone }) {
  if (!store || !session || !Array.isArray(session.history) || !session.history.length) {
    return null;
  }

  const lastMsg = session.history[session.history.length - 1];
  const unanswered = lastMsg?.role === 'user';
  const contactLabel = session.clientName ? `${session.clientName} (${phone})` : String(phone || 'contato');
  const rawSnippet = String(lastMsg?.text || '').replace(/\s+/g, ' ').trim();
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
    selfSession.history.push({ role: 'assistant', content: message, text: message, createdAt: nowIso });
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
