import crypto from 'node:crypto';
import { json, readBody, authorized, NOT_HANDLED } from './utils.mjs';
import { config } from '../config.mjs';
import { parsePayload, isMessageUpsert, isIgnoredJid, wasSentByBot, sendText, markChatAsRead } from '../whatsapp.mjs';
import { resolveIdentity, isOwnerContact, escapeRegExp, OWNER_SELF_KEY } from '../core/identity.mjs';
import { broadcastBridgeEvent } from './bridge.mjs';
import { handleInboundOptOut } from '../prospecting/optout.mjs';

export function stableIdlessEventKey(item, event) {
  const timestamp = item.eventTimestamp;
  if (!timestamp) return null;
  const contentDigest = crypto.createHash('sha256').update(JSON.stringify(item.message || {})).digest('hex');
  const material = JSON.stringify({
    event,
    instance: item.instance || '',
    jid: item.jid || '',
    phone: item.phone || '',
    timestamp,
    mediaType: item.mediaType || '',
    text: item.text || '',
    contentDigest,
    fromMe: Boolean(item.fromMe)
  });
  return `fingerprint:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

export async function isWebhookAuthorized(req, webhookAuthorize) {
  try {
    const result = typeof webhookAuthorize === 'function'
      ? await webhookAuthorize(req)
      : authorized(req);
    return typeof result === 'object' && result !== null ? result.ok === true : result === true;
  } catch {
    return false;
  }
}

// Webhooks do WhatsApp/Evolution. O ledger guarda apenas hash da chave, tipo e estado.
export async function handleWebhookRoutes({ req, res, u, store, f, adminConfig, webhookAuthorize, schedule, getHumanPhone, getCachedInstanceOwner, updateInstanceOwner, rateMessage, webhookEventStore, campaignStore = null, prospecting = null }) {
  if (req.method !== 'POST' || !['/webhook', '/webhook/evolution'].includes(u.pathname)) return NOT_HANDLED;
  if (!await isWebhookAuthorized(req, webhookAuthorize)) return json(res, 401, { error: 'unauthorized' });

  let payload;
  try { payload = await readBody(req); }
  catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }

  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ accepted: true }));

  const item = parsePayload(payload);
  const messageId = item.key?.id || payload?.data?.key?.id || payload?.key?.id;
  const rawEvent = String(item.event || payload?.event || payload?.type || '').toUpperCase().replace(/[._]/g, '').slice(0, 120) || 'UNKNOWN';
  const stableEventKey = messageId ? `${item.instance || ''}:${rawEvent}:${messageId}` : stableIdlessEventKey(item, rawEvent);
  const id = messageId || stableEventKey;
  let tracking = { tracked: false, duplicate: false, key: null };
  try {
    if (stableEventKey) tracking = await webhookEventStore?.begin({ key: stableEventKey, eventType: rawEvent, instance: item.instance || '' }) || tracking;
  } catch (error) {
    console.warn(`[webhook-ledger] indisponível (${String(error?.code || 'ledger_unavailable')})`);
  }
  if (tracking.duplicate) return;
  const finish = async (status, code = null) => {
    try { await webhookEventStore?.finish(tracking, status, code); }
    catch (error) { console.warn(`[webhook-ledger] estado não persistido (${String(error?.code || 'ledger_unavailable')})`); }
  };

  try {
    if (config.evolutionInstance && item.instance && item.instance !== config.evolutionInstance) {
      await finish('ignored', 'instance_mismatch');
      return;
    }

    const identity = resolveIdentity(adminConfig.active);
    const ownerLabel = identity.responsible || 'Responsável';
    if (['CONNECTION_UPDATE', 'CONNECTIONUPDATE', 'QRCODE_UPDATED'].includes(rawEvent)) {
      await updateInstanceOwner().catch(() => {});
      await finish('processed');
      return;
    }

    const syncCfg = adminConfig?.active?.sync || {};
    if (syncCfg.whatsappSyncEnabled) {
      const archiveMode = syncCfg.archiveDeletedMessages !== false;
      if (['CHATSDELETE', 'CHATS_DELETE'].includes(rawEvent)) {
        const entries = Array.isArray(payload?.data) ? payload.data : [payload?.data];
        for (const entry of entries) {
          const rawJid = typeof entry === 'string' ? entry : (entry?.id || entry?.remoteJid || item.jid || item.phone || '');
          const cleanJid = String(rawJid || '').trim();
          const candidateKey = /@lid$/i.test(cleanJid) ? cleanJid : cleanJid.replace(/@.*$/, '').replace(/\D/g, '');
          const targetPhone = (await store.resolveConversationKey?.(candidateKey)) || candidateKey;
          if (targetPhone) {
            await store.softDeleteConversation?.({ key: targetPhone, source: 'whatsapp', archive: archiveMode });
            broadcastBridgeEvent('whatsapp_sync', { action: 'chat_deleted', phone: targetPhone, archived: archiveMode, timestamp: Date.now() });
          }
        }
        await finish('processed', 'chat_deleted_sync');
        return;
      }
      if (['MESSAGESDELETE', 'MESSAGES_DELETE', 'MESSAGESUPDATE', 'MESSAGES_UPDATE'].includes(rawEvent)) {
        const isUpdate = ['MESSAGESUPDATE', 'MESSAGES_UPDATE'].includes(rawEvent);
        const isRevoke = !isUpdate || payload?.data?.messageStubType === 'REVOKE' || payload?.data?.update?.messageStubType === 'REVOKE' || payload?.data?.status === 'DELETED';
        const deletedId = payload?.data?.key?.id || payload?.data?.id || messageId;
        if (isRevoke && deletedId) {
          await store.softDeleteMessage?.({ externalId: deletedId, source: 'whatsapp', archive: archiveMode });
          broadcastBridgeEvent('whatsapp_sync', { action: 'message_deleted', messageId: deletedId, archived: archiveMode, timestamp: Date.now() });
        }
        await finish('processed', isRevoke ? 'message_deleted_sync' : 'message_update_ignored');
        return;
      }
      const protoRevoke = payload?.data?.message?.protocolMessage;
      if (isMessageUpsert(item.event) && protoRevoke && (protoRevoke.type === 0 || protoRevoke.type === 'REVOKE') && protoRevoke.key?.id) {
        await store.softDeleteMessage?.({ externalId: protoRevoke.key.id, source: 'whatsapp', archive: archiveMode });
        broadcastBridgeEvent('whatsapp_sync', { action: 'message_deleted', messageId: protoRevoke.key.id, archived: archiveMode, timestamp: Date.now() });
        await finish('processed', 'protocol_revoke_sync');
        return;
      }
      if (['CHATSUPDATE', 'CHATS_UPDATE'].includes(rawEvent)) {
        const rawData = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
        const cleanJid = String(rawData?.id || rawData?.remoteJid || item.jid || item.phone || '').trim();
        const candidateKey = /@lid$/i.test(cleanJid) ? cleanJid : cleanJid.replace(/@.*$/, '').replace(/\D/g, '');
        const targetPhone = (await store.resolveConversationKey?.(candidateKey)) || candidateKey;
        if (targetPhone && typeof rawData?.archive === 'boolean') {
          if (rawData.archive) await store.archive?.(targetPhone, 'arquivado_no_whatsapp');
          broadcastBridgeEvent('whatsapp_sync', { action: 'chat_archived', phone: targetPhone, archived: rawData.archive, timestamp: Date.now() });
        }
        await finish('processed', 'chat_update_sync');
        return;
      }
    }

    if (!isMessageUpsert(item.event) || isIgnoredJid(item.jid) || !item.phone) {
      await finish('ignored', 'unsupported_event');
      return;
    }
    if ((item.lid || item.jid) && item.phone) store.rememberLid?.(item.lid || item.jid, item.phone);

    const isOwnerSelf = (jid = '', phone = '') => {
      const options = { humanPhone: getHumanPhone(), cachedOwner: getCachedInstanceOwner(), identity };
      return isOwnerContact(jid, options) || isOwnerContact(phone, options);
    };
    const isSelfChat = isOwnerSelf(item.jid, item.phone);
    const isCallingAssistantDirectly = new RegExp(`^[@/]?${escapeRegExp(identity.botName)}\\b`, 'i').test(String(item.text || '').trim());

    if (item.fromMe) {
      if (!wasSentByBot(id, item.phone, item.text)) {
        await new Promise(resolve => setTimeout(resolve, 400));
        if (!wasSentByBot(id, item.phone, item.text)) {
          if (/^[!/#]?(?:bot|reativar)\b/i.test(item.text?.trim())) {
            const session = store.get(item.phone);
            if (session) {
              session.human = false;
              session.humanSource = 'resume';
              session.handoffAt = null;
              session.handoffReminderAt = null;
              session.handoffReminder1Sent = false;
              session.handoffReminder60Sent = false;
              session.handoffNotified = false;
              session.inactivityClosed = false;
              session.updatedAt = new Date().toISOString();
              store.markDirty();
              await store.flush?.();
            }
            await finish('processed');
            return;
          }

          if (isSelfChat || isCallingAssistantDirectly) {
            broadcastBridgeEvent('whatsapp_message', {
              id: messageId || undefined,
              phone: OWNER_SELF_KEY,
              jid: item.jid || item.phone,
              text: item.text || '🎤 [Áudio / Mídia]',
              fromMe: false,
              pushName: `${ownerLabel} (Copiloto)`,
              timestamp: Date.now()
            });
            await schedule({
              phone: OWNER_SELF_KEY,
              jid: item.jid || item.phone,
              text: item.text,
              nonText: item.nonText,
              mediaType: item.mediaType,
              rawItem: item,
              pushName: ownerLabel,
              keyId: id
            });
            await finish('processed');
            return;
          }
          const session = store.get(item.phone);
          if (session) {
            session.human = true;
            session.humanSource = 'takeover';
            session.handoffAt = new Date().toISOString();
            session.takeoverAt = new Date().toISOString();
            session.handoffReason = 'atendente humano respondeu no WhatsApp';
            session.handoffReminderAt = null;
            session.updatedAt = new Date().toISOString();
            if (item.text && item.text.trim()) {
              session.history ??= [];
              session.history.push({ role: 'assistant', content: item.text.trim() });
              if (session.history.length > 40) session.history = session.history.slice(-30);
            }
            store.markDirty();
            await store.flush?.();
          }
          broadcastBridgeEvent('whatsapp_message', {
            id,
            phone: item.phone,
            jid: item.jid,
            text: item.text,
            fromMe: true,
            isHumanAgent: true,
            timestamp: Date.now()
          });
          await finish('processed');
          return;
        }
      }
      await finish('ignored', 'bot_echo');
      return;
    }

    if (f.isDuplicate(id)) {
      await finish('ignored', 'duplicate_message');
      return;
    }
    if (!f.allowRate(item.phone)) {
      if (f.shouldWarnRate(item.phone)) sendText(item.jid || item.phone, rateMessage).catch(error => console.error('[rate-limit]', error?.code || error?.name || 'send_failed'));
      await finish('ignored', 'rate_limited');
      return;
    }

    if (isSelfChat) {
      broadcastBridgeEvent('whatsapp_message', {
        id: messageId || undefined,
        phone: OWNER_SELF_KEY,
        jid: item.jid || item.phone,
        text: item.text || '🎤 [Áudio / Mídia]',
        fromMe: false,
        pushName: `${ownerLabel} (Copiloto)`,
        timestamp: Date.now()
      });
      await schedule({
        phone: OWNER_SELF_KEY,
        jid: item.jid || item.phone,
        text: item.text,
        nonText: item.nonText,
        mediaType: item.mediaType,
        rawItem: item,
        pushName: ownerLabel,
        keyId: id
      });
      await finish('processed');
      return;
    }

    if (item.text && (campaignStore || prospecting)) {
      const optOut = await handleInboundOptOut({
        phone: item.phone,
        jid: item.jid || item.phone,
        text: item.text,
        campaignStore,
        prospectStore: prospecting?.leadStore || null,
        send: sendText
      });
      if (optOut.matched) {
        await finish('processed', 'opt_out');
        return;
      }
    }

    if (adminConfig?.active?.sync?.whatsappSyncEnabled && adminConfig?.active?.sync?.readReceipts && messageId) {
      markChatAsRead({ jid: item.jid || item.phone, messageId, fromMe: false }).catch(() => {});
    }

    broadcastBridgeEvent('whatsapp_message', {
      id: messageId || undefined,
      phone: item.phone,
      jid: item.jid || item.phone,
      text: item.text || '🎤 [Áudio / Mídia recebido]',
      fromMe: false,
      pushName: item.pushName,
      timestamp: Date.now()
    });
    await schedule({
      phone: item.phone,
      jid: item.jid || item.phone,
      text: item.text,
      nonText: item.nonText,
      mediaType: item.mediaType,
      rawItem: item,
      pushName: item.pushName,
      keyId: id
    });
    await finish('processed');
  } catch (error) {
    await finish('failed', error?.code || error?.name || 'processing_failed');
    console.error('[webhook] processamento falhou', error?.code || error?.name || 'processing_failed');
  }
}
