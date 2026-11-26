import { config } from '../config.mjs';
import { cleanJidPhone } from '../sessions.mjs';
import { buildInboundEvent } from './inbound-normalizer.mjs';

const MANYCHAT_API = 'https://api.manychat.com/fb';
const phoneToSubscriberId = new Map();

/**
 * Associa o telefone normalizado ao subscriber_id do ManyChat.
 */
export function registerManyChatSubscriber(phone, subscriberId) {
  const key = cleanJidPhone(phone);
  const id = String(subscriberId || '').trim();
  if (!key || !id) return;
  phoneToSubscriberId.set(key, id);
  if (phoneToSubscriberId.size > 5000) {
    phoneToSubscriberId.delete(phoneToSubscriberId.keys().next().value);
  }
}

export function getManyChatSubscriberId(phoneOrJid) {
  const key = cleanJidPhone(phoneOrJid);
  return key ? (phoneToSubscriberId.get(key) || null) : null;
}

/**
 * Converte o payload "Full Contact Data" do ManyChat para o contrato interno
 * esperado por processWhatsAppWebhookPayload.
 */
export function parseManyChatWebhookPayload(body = {}) {
  const subscriberId = String(body.id || '').trim();
  const rawPhone = body.whatsapp_phone || subscriberId;
  const phone = cleanJidPhone(rawPhone);
  if (phone && subscriberId) {
    registerManyChatSubscriber(phone, subscriberId);
  }

  return buildInboundEvent({
    instance: 'manychat',
    externalId: subscriberId,
    rawPhone,
    pushName: body.name || '',
    text: body.last_input_text || '',
    audioUrl: body.last_input_audio_url || body.audio_url || '',
    imageUrl: body.last_input_image_url || body.image_url || '',
  });
}

async function mcPost(token, path, payload, fetchFn = fetch) {
  const res = await fetchFn(`${MANYCHAT_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`ManyChat ${path} -> ${res.status}: ${text}`), {
      code: `manychat_http_${res.status}`,
    });
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Envia texto para um contato via ManyChat (grava no custom field e dispara sendFlow).
 */
export async function sendManyChatText(phoneOrJid, text, {
  token = config.manychatToken,
  replyFieldId = config.manychatReplyFieldId,
  sendflowNs = config.manychatSendflowNs,
  subscriberId = null,
  fetchFn = fetch,
} = {}) {
  if (!token || !replyFieldId || !sendflowNs) {
    throw new Error('ManyChat não configurado (MANYCHAT_TOKEN, MANYCHAT_REPLY_FIELD_ID, MANYCHAT_SENDFLOW_NS)');
  }
  const targetId = String(subscriberId || getManyChatSubscriberId(phoneOrJid) || '').trim();
  if (!targetId) {
    throw new Error(`subscriber_id do ManyChat não encontrado para ${cleanJidPhone(phoneOrJid) || 'contato'}`);
  }

  await mcPost(token, '/subscriber/setCustomField', {
    subscriber_id: targetId,
    field_id: Number(replyFieldId),
    field_value: String(text || ''),
  }, fetchFn);

  return mcPost(token, '/subscriber/sendFlow', {
    subscriber_id: targetId,
    flow_ns: sendflowNs,
  }, fetchFn);
}

/**
 * Aplica a tag de handoff no ManyChat para pausar a automação e transferir para humano.
 */
export async function tagManyChatHandoff(phoneOrJid, {
  token = config.manychatToken,
  transferTagName = config.manychatTransferTag,
  subscriberId = null,
  fetchFn = fetch,
} = {}) {
  if (!token) throw new Error('MANYCHAT_TOKEN não configurado');
  const targetId = String(subscriberId || getManyChatSubscriberId(phoneOrJid) || '').trim();
  if (!targetId) return null;

  return mcPost(token, '/subscriber/addTagByName', {
    subscriber_id: targetId,
    tag_name: transferTagName || 'transferido-humano',
  }, fetchFn);
}
