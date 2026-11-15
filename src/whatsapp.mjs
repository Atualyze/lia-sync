import crypto from 'node:crypto';
import { config } from './config.mjs';
import { normalizePhone } from './sessions.mjs';
import { normalize } from './safety.mjs';

const sent = new Set();
const recentSent = new Map();
let outboundSuppressionCheck = null;

export function setOutboundSuppressionCheck(check) {
  outboundSuppressionCheck = typeof check === 'function' ? check : null;
}

async function assertNotSuppressed(jid) {
  if (!outboundSuppressionCheck) throw Object.assign(new Error('suppression_check_unavailable'), { code: 'suppression_check_unavailable' });
  const recipient = normalizePhone(String(jid || '').replace(/@.*$/, '').replace(/\D/g, ''));
  if (!/^\d{8,15}$/.test(recipient)) throw Object.assign(new Error('invalid_suppression_target'), { code: 'invalid_suppression_target' });
  let suppression;
  try {
    suppression = await outboundSuppressionCheck(recipient);
  } catch {
    throw Object.assign(new Error('supression_check_unavailable'), { code: 'suppression_check_unavailable' });
  }
  if (suppression) throw Object.assign(new Error('recipient_opted_out'), { code: 'recipient_opted_out' });
}

const remember = id => {
  if (!id) return;
  sent.add(id);
  if (sent.size > 1000) sent.delete(sent.values().next().value);
};

export function recordBotSend(phone, text) {
  if (!phone || !text) return;
  const p = normalizePhone(String(phone).replace(/@.*$/, ''));
  const t = normalize(String(text));
  const key = `${p}:${t}`;
  recentSent.set(key, Date.now());
  if (recentSent.size > 1000) recentSent.delete(recentSent.keys().next().value);
}

export function wasSentByBot(id, phone = '', text = '') {
  if (id && sent.has(id)) return true;
  if (phone && text) {
    const p = normalizePhone(String(phone).replace(/@.*$/, ''));
    const t = normalize(String(text));
    const key = `${p}:${t}`;
    const timestamp = recentSent.get(key);
    if (timestamp && Date.now() - timestamp < 60000) return true;
  }
  return false;
}

export function parsePayload(data) {
  const d = data?.data || data;
  const key = d?.key || {};
  const message = d?.message || {};
  const jid = String(key.remoteJid || d?.remoteJid || '');
  const alt = String(d.remoteJidAlt || d.senderPn || d.participantPn || key.remoteJidAlt || '');
  const rawPhone = alt ? alt.split('@')[0].replace(/\D/g, '') : /@lid$/i.test(jid) ? jid : jid.split('@')[0].replace(/\D/g, '');
  const phone = /@lid$/i.test(rawPhone) ? rawPhone : normalizePhone(rawPhone);

  const text = message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    d.content || '';

  let mediaType = null;
  if (message.audioMessage) mediaType = 'audio';
  else if (message.imageMessage) mediaType = 'image';
  else if (message.videoMessage) mediaType = 'video';
  else if (message.documentMessage) mediaType = 'document';
  else if (message.stickerMessage) mediaType = 'sticker';

  const nonText = !text && Boolean(mediaType);
  const rawTimestamp = d.messageTimestamp || d.message?.messageTimestamp || d.timestamp || key.messageTimestamp;
  const timestampNumber = Number(rawTimestamp);
  const eventTimestamp = Number.isFinite(timestampNumber) && timestampNumber > 0
    ? (timestampNumber < 1e12 ? timestampNumber * 1000 : timestampNumber)
    : (rawTimestamp ? new Date(rawTimestamp).getTime() : 0);

  return {
    event: data?.event || data?.type || '',
    instance: data?.instance || d?.instance || '',
    key,
    message,
    jid,
    phone,
    text,
    nonText,
    mediaType,
    eventTimestamp: Number.isFinite(eventTimestamp) && eventTimestamp > 0 ? eventTimestamp : null,
    fromMe: Boolean(key.fromMe || d.fromMe),
    pushName: d.pushName || d.pushname || key.pushName || ''
  };
}

export async function getInstanceOwnerPhone() {
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) return null;
  try {
    const res = await fetch(`${config.evolutionUrl}/instance/fetchInstances`, {
      headers: { apikey: config.evolutionKey }
    });
    if (!res.ok) return null;
    const list = await res.json();
    if (Array.isArray(list)) {
      const inst = list.find(x => x.name === config.evolutionInstance);
      if (inst?.ownerJid) {
        return inst.ownerJid.replace(/@.*$/, '').replace(/\D/g, '');
      }
    }
  } catch (err) {
    console.warn('[evolution] Falha ao consultar instâncias:', err.message);
  }
  return null;
}

export function isMessageUpsert(event) {
  return ['MESSAGESUPSERT', 'MESSAGES_UPSERT'].includes(String(event).toUpperCase().replace(/[._]/g, ''));
}

export function isIgnoredJid(jid) {
  return /(@g\.us|@broadcast|^status@broadcast$|@newsletter)$/i.test(jid);
}

const providerTimeoutMs = () => Math.max(1000, Number(process.env.EVOLUTION_SEND_TIMEOUT_MS || 15000));
// Headers HTTP precisam conter apenas caracteres ByteString. O texto da resposta
// pode conter emoji/Unicode; portanto o payload nunca deve ser colocado no header.
export const providerKey = (kind, jid, payload) => `lia:${kind}:${crypto.createHash('sha256').update(JSON.stringify({ jid, payload }), 'utf8').digest('hex')}`;
async function providerSend(url, payload, kind, jid) {
  const key = providerKey(kind, jid, payload);
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', apikey: config.evolutionKey, 'x-idempotency-key': key, 'idempotency-key': key }, signal: AbortSignal.timeout(providerTimeoutMs()), body: JSON.stringify(payload) });
  } catch (cause) {
    throw Object.assign(new Error('Evolution resultado de entrega desconhecido'), { code: 'evolution_delivery_unknown', deliveryUnknown: true, cause });
  }
  if (!response.ok) {
    const deliveryUnknown = response.status >= 500;
    throw Object.assign(new Error(`Evolution ${response.status}`), { code: deliveryUnknown ? 'evolution_delivery_unknown' : `evolution_http_${response.status}`, deliveryUnknown });
  }
  let text;
  try { text = await response.text(); }
  catch (cause) { throw Object.assign(new Error('Evolution resultado de entrega desconhecido'), { code: 'evolution_delivery_unknown', deliveryUnknown: true, cause }); }
  let result = {};
  try { result = text ? JSON.parse(text) : {}; }
  catch (cause) { throw Object.assign(new Error('Evolution resposta inválida; resultado de entrega desconhecido'), { code: 'evolution_delivery_unknown', deliveryUnknown: true, cause }); }
  if (result?.error) throw Error('Evolution rejeitou o envio');
  return { result, id: result?.key?.id || result?.data?.key?.id || result?.message?.key?.id };
}

export async function getMediaBase64(item) {
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) return null;
  const key = item?.key;
  const message = item?.message;
  if (!key) return null;
  try {
    const res = await fetch(`${config.evolutionUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(config.evolutionInstance)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
      body: JSON.stringify({ message: { key, message }, convertToMp4: false })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.base64 ? { base64: data.base64, mimetype: data.mimetype } : null;
  } catch (e) {
    console.error('[media] Falha ao extrair base64:', e.message);
    return null;
  }
}

export async function sendText(jid, text, { retry = 2, onSent } = {}) {
  await assertNotSuppressed(jid);
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) throw Error('Evolution não configurada');
  recordBotSend(jid, text);
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      await fetch(`${config.evolutionUrl}/chat/sendPresence/${encodeURIComponent(config.evolutionInstance)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
        signal: AbortSignal.timeout(providerTimeoutMs()),
        body: JSON.stringify({ number: jid, presence: 'composing', delay: 500 })
      }).catch(() => {});

      const { result: j, id } = await providerSend(`${config.evolutionUrl}/message/sendText/${encodeURIComponent(config.evolutionInstance)}`, { number: jid, text, delay: Math.min(3000, 400 + 25 * text.length) }, 'text', jid);
      j && remember(id);
      onSent?.(id);
      return j;
    } catch (e) {
      last = e;
      if (i < retry) await new Promise(r => setTimeout(r, Math.min(3000, 1000 * (i + 1))));
    }
  }
  throw last;
}

export async function sendDocument(jid, { dataUrl, base64, fileName = 'documento.pdf', mimetype = 'application/pdf', caption = '' } = {}, { retry = 2, onSent } = {}) {
  await assertNotSuppressed(jid);
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) throw Error('Evolution não configurada');
  const cleanB64 = String(dataUrl || base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!cleanB64) throw Error('Documento sem conteúdo para envio');
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      await fetch(`${config.evolutionUrl}/chat/sendPresence/${encodeURIComponent(config.evolutionInstance)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
        signal: AbortSignal.timeout(providerTimeoutMs()),
        body: JSON.stringify({ number: jid, presence: 'composing', delay: 500 })
      }).catch(() => {});

      const { result: j, id } = await providerSend(`${config.evolutionUrl}/message/sendMedia/${encodeURIComponent(config.evolutionInstance)}`, { number: jid, mediatype: 'document', mimetype, fileName, media: cleanB64, ...(caption ? { caption } : {}) }, 'document', jid);
      j && remember(id);
      onSent?.(id);
      return j;
    } catch (e) {
      last = e;
      if (i < retry) await new Promise(r => setTimeout(r, Math.min(3000, 1000 * (i + 1))));
    }
  }
  throw last;
}

export async function sendImage(jid, { dataUrl, base64, mimetype = 'image/png', caption = '' } = {}, { retry = 2, onSent } = {}) {
  await assertNotSuppressed(jid);
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) throw Error('Evolution não configurada');
  const cleanB64 = String(dataUrl || base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!cleanB64) throw Error('Imagem sem conteúdo para envio');
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      await fetch(`${config.evolutionUrl}/chat/sendPresence/${encodeURIComponent(config.evolutionInstance)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
        signal: AbortSignal.timeout(providerTimeoutMs()),
        body: JSON.stringify({ number: jid, presence: 'composing', delay: 400 })
      }).catch(() => {});

      const { result: j, id } = await providerSend(`${config.evolutionUrl}/message/sendMedia/${encodeURIComponent(config.evolutionInstance)}`, { number: jid, mediatype: 'image', mimetype, media: cleanB64, ...(caption ? { caption } : {}) }, 'image', jid);
      j && remember(id);
      onSent?.(id);
      return j;
    } catch (e) {
      last = e;
      if (i < retry) await new Promise(r => setTimeout(r, Math.min(3000, 1000 * (i + 1))));
    }
  }
  throw last;
}

export async function sendWhatsAppAudio(jid, audioBase64, { retry = 0, onSent } = {}) {
  await assertNotSuppressed(jid);
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) throw Error('Evolution não configurada');
  const cleanB64 = String(audioBase64).replace(/^data:audio\/[^;]+;base64,/, '');
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      await fetch(`${config.evolutionUrl}/chat/sendPresence/${encodeURIComponent(config.evolutionInstance)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
        signal: AbortSignal.timeout(providerTimeoutMs()),
        body: JSON.stringify({ number: jid, presence: 'recording', delay: 500 })
      }).catch(() => {});

      const { result: j, id } = await providerSend(`${config.evolutionUrl}/message/sendWhatsAppAudio/${encodeURIComponent(config.evolutionInstance)}`, { number: jid, audio: cleanB64, encoding: true }, 'audio', jid);
      j && remember(id);
      onSent?.(id);
      return j;
    } catch (e) {
      last = e;
      if (e?.deliveryUnknown || !/^evolution_http_429$/.test(e?.code || '') || i >= retry) throw e;
      await new Promise(r => setTimeout(r, Math.min(3000, 1000 * (i + 1))));
    }
  }
  throw last;
}

function toRemoteJid(jid = '') {
  const s = String(jid || '').trim();
  if (!s) return '';
  return s.includes('@') ? s : `${s.replace(/\D/g, '')}@s.whatsapp.net`;
}

export async function markChatAsRead({ jid, messageId, fromMe = false } = {}) {
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance || !jid || !messageId) return { ok: false };
  try {
    const res = await fetch(`${config.evolutionUrl}/chat/markMessageAsRead/${encodeURIComponent(config.evolutionInstance)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
      signal: AbortSignal.timeout(providerTimeoutMs()),
      body: JSON.stringify({
        readMessages: [{ remoteJid: toRemoteJid(jid), fromMe: Boolean(fromMe), id: String(messageId) }]
      })
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

export async function archiveChat({ jid, archive = true } = {}) {
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance || !jid) return { ok: false };
  try {
    const res = await fetch(`${config.evolutionUrl}/chat/archiveChat/${encodeURIComponent(config.evolutionInstance)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
      signal: AbortSignal.timeout(providerTimeoutMs()),
      body: JSON.stringify({
        chat: toRemoteJid(jid),
        archive: Boolean(archive)
      })
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

export async function deleteChatForSync({ jid } = {}) {
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance || !jid) return { ok: false };
  try {
    const res = await fetch(`${config.evolutionUrl}/chat/delete/${encodeURIComponent(config.evolutionInstance)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
      signal: AbortSignal.timeout(providerTimeoutMs()),
      body: JSON.stringify({ chat: toRemoteJid(jid) })
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
