import { json, readBody, authorized, NOT_HANDLED } from './utils.mjs';
import { config } from '../config.mjs';
import { parsePayload, isMessageUpsert, isIgnoredJid, wasSentByBot, sendText } from '../whatsapp.mjs';
import { resolveIdentity, isOwnerContact, escapeRegExp, OWNER_SELF_KEY } from '../core/identity.mjs';
import { broadcastBridgeEvent } from './bridge.mjs';

// Webhooks do WhatsApp/Evolution.
export async function handleWebhookRoutes({ req, res, u, store, f, adminConfig, webhookAuthorize, schedule, getHumanPhone, getCachedInstanceOwner, updateInstanceOwner, rateMessage }) {
  if (req.method === 'POST' && (u.pathname === '/webhook' || u.pathname === '/webhook/evolution')) {
    if (!(webhookAuthorize ? await webhookAuthorize(req) : authorized(req))) return json(res, 401, { error: 'unauthorized' });
    let payload;
    try { payload = await readBody(req); } catch (e) { return json(res, e.statusCode || 400, { error: e.message }); }
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));

    const item = parsePayload(payload);
    const id = item.key?.id || payload?.data?.key?.id || payload?.key?.id;
    if (config.evolutionInstance && item.instance && item.instance !== config.evolutionInstance) return;

    const identity = resolveIdentity(adminConfig.active);
    const ownerLabel = identity.responsible || 'Responsável';

    const rawEvent = String(item.event || payload?.event || payload?.type || '').toUpperCase().replace(/[._]/g, '');
    if (['CONNECTION_UPDATE', 'CONNECTIONUPDATE', 'QRCODE_UPDATED'].includes(rawEvent)) {
      await updateInstanceOwner().catch(() => {});
      return;
    }

    if (!isMessageUpsert(item.event) || isIgnoredJid(item.jid) || !item.phone) return;

    const isOwnerSelf = (jid = '', phone = '') => {
      const options = { humanPhone: getHumanPhone(), cachedOwner: getCachedInstanceOwner(), identity };
      return isOwnerContact(jid, options) || isOwnerContact(phone, options);
    };

    const isSelfChat = isOwnerSelf(item.jid, item.phone);
    const isCallingAssistantDirectly = new RegExp(`^[@/]?${escapeRegExp(identity.botName)}\\b`, 'i').test(String(item.text || '').trim());

    if (item.fromMe) {
      if (!wasSentByBot(id, item.phone, item.text)) {
        await new Promise(r => setTimeout(r, 400));
        if (!wasSentByBot(id, item.phone, item.text)) {
          // Comando inline do operador no chat com o cliente: reativa o bot
          if (/^[!/#]?(?:bot|reativar)\b/i.test(item.text?.trim())) {
            const session = store.get(item.phone);
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
            return;
          }

          if (isSelfChat || isCallingAssistantDirectly) {
            broadcastBridgeEvent('whatsapp_message', {
              id,
              phone: OWNER_SELF_KEY,
              jid: item.jid || item.phone,
              text: item.text || '🎤 [Áudio / Mídia]',
              fromMe: false,
              pushName: `${ownerLabel} (Copiloto)`,
              timestamp: Date.now()
            });
            schedule({
              phone: OWNER_SELF_KEY,
              jid: item.jid || item.phone,
              text: item.text,
              nonText: item.nonText,
              mediaType: item.mediaType,
              rawItem: item,
              pushName: ownerLabel,
              keyId: id
            });
            return;
          }
          const session = store.get(item.phone);
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
            if (session.history.length > 40) {
              session.history = session.history.slice(-30);
            }
          }
          store.markDirty();
          await store.flush?.();
          broadcastBridgeEvent('whatsapp_message', {
            id,
            phone: item.phone,
            jid: item.jid,
            text: item.text,
            fromMe: true,
            isHumanAgent: true,
            timestamp: Date.now()
          });
        }
      }
      return;
    }

    if (f.isDuplicate(id)) return;
    if (!f.allowRate(item.phone)) {
      if (f.shouldWarnRate(item.phone)) sendText(item.jid || item.phone, rateMessage).catch(e => console.error('[rate-limit]', e.message));
      return;
    }

    // Se a mensagem recebida veio do responsável ou chamando a assistente: direciona para o Copiloto Interno
    if (isSelfChat || isCallingAssistantDirectly) {
      broadcastBridgeEvent('whatsapp_message', {
        id,
        phone: OWNER_SELF_KEY,
        jid: item.jid || item.phone,
        text: item.text || '🎤 [Áudio / Mídia]',
        fromMe: false,
        pushName: `${ownerLabel} (Copiloto)`,
        timestamp: Date.now()
      });
      schedule({
        phone: OWNER_SELF_KEY,
        jid: item.jid || item.phone,
        text: item.text,
        nonText: item.nonText,
        mediaType: item.mediaType,
        rawItem: item,
        pushName: ownerLabel,
        keyId: id
      });
      return;
    }

    broadcastBridgeEvent('whatsapp_message', {
      id,
      phone: item.phone,
      jid: item.jid || item.phone,
      text: item.text || '🎤 [Áudio / Mídia recebido]',
      fromMe: false,
      pushName: item.pushName,
      timestamp: Date.now()
    });

    schedule({
      phone: item.phone,
      jid: item.jid || item.phone,
      text: item.text,
      nonText: item.nonText,
      mediaType: item.mediaType,
      rawItem: item,
      pushName: item.pushName,
      keyId: id
    });
    return;
  }
  return NOT_HANDLED;
}
