import { config } from './config.mjs';
import { normalizePhone } from './sessions.mjs';
import { normalize } from './safety.mjs';

const sent = new Set();
const recentSent = new Map();

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
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) throw Error('Evolution não configurada');
  recordBotSend(jid, text);
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      await fetch(`${config.evolutionUrl}/chat/sendPresence/${encodeURIComponent(config.evolutionInstance)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
        body: JSON.stringify({ number: jid, presence: 'composing', delay: 500 })
      }).catch(() => {});

      const r = await fetch(`${config.evolutionUrl}/message/sendText/${encodeURIComponent(config.evolutionInstance)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
        body: JSON.stringify({ number: jid, text, delay: Math.min(3000, 400 + 25 * text.length) })
      });
      if (!r.ok) throw Error(`Evolution ${r.status}`);
      const j = await r.json().catch(() => ({}));
      const id = j?.key?.id || j?.data?.key?.id;
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
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) throw Error('Evolution não configurada');
  const cleanB64 = String(dataUrl || base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!cleanB64) throw Error('Documento sem conteúdo para envio');
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      await fetch(`${config.evolutionUrl}/chat/sendPresence/${encodeURIComponent(config.evolutionInstance)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
        body: JSON.stringify({ number: jid, presence: 'composing', delay: 500 })
      }).catch(() => {});

      const r = await fetch(`${config.evolutionUrl}/message/sendMedia/${encodeURIComponent(config.evolutionInstance)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
        body: JSON.stringify({
          number: jid,
          mediatype: 'document',
          mimetype,
          fileName,
          media: cleanB64,
          ...(caption ? { caption } : {})
        })
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        throw Error(`Evolution Document ${r.status}: ${errText}`);
      }
      const j = await r.json().catch(() => ({}));
      const id = j?.key?.id || j?.data?.key?.id;
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

export async function sendWhatsAppAudio(jid, audioBase64, { retry = 2, onSent } = {}) {
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) throw Error('Evolution não configurada');
  const cleanB64 = String(audioBase64).replace(/^data:audio\/[^;]+;base64,/, '');
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      await fetch(`${config.evolutionUrl}/chat/sendPresence/${encodeURIComponent(config.evolutionInstance)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
        body: JSON.stringify({ number: jid, presence: 'recording', delay: 500 })
      }).catch(() => {});

      const r = await fetch(`${config.evolutionUrl}/message/sendWhatsAppAudio/${encodeURIComponent(config.evolutionInstance)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: config.evolutionKey },
        body: JSON.stringify({ number: jid, audio: cleanB64, encoding: true })
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        throw Error(`Evolution Audio ${r.status}: ${errText}`);
      }
      const j = await r.json().catch(() => ({}));
      const id = j?.key?.id || j?.data?.key?.id;
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
