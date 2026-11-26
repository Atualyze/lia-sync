import { config } from '../config.mjs';
import { cleanJidPhone } from '../sessions.mjs';
import { buildInboundEvent } from './inbound-normalizer.mjs';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const phoneToGhlContact = new Map();

/**
 * Associa o telefone normalizado ao contactId (e locationId) do GoHighLevel.
 */
export function registerGhlContact(phone, contactId, locationId = '') {
  const key = cleanJidPhone(phone);
  const id = String(contactId || '').trim();
  if (!key || !id) return;
  phoneToGhlContact.set(key, { contactId: id, locationId: String(locationId || '').trim() });
  if (phoneToGhlContact.size > 5000) {
    phoneToGhlContact.delete(phoneToGhlContact.keys().next().value);
  }
}

export function getGhlContact(phoneOrJid) {
  const key = cleanJidPhone(phoneOrJid);
  return key ? (phoneToGhlContact.get(key) || null) : null;
}

/**
 * Converte o payload de webhook do GoHighLevel (Workflow Custom Webhook ou Inbound)
 * para o contrato interno esperado por processWhatsAppWebhookPayload.
 */
export function parseGhlWebhookPayload(body = {}) {
  const contactId = String(body.contact_id || body.contactId || body.id || '').trim();
  const locationId = String(body.location_id || body.locationId || body.location?.id || '').trim();
  const rawPhone = body.phone || body.contact?.phone || contactId;
  const phone = cleanJidPhone(rawPhone);

  if (phone && contactId) {
    registerGhlContact(phone, contactId, locationId);
  }

  const rawText = typeof body.message === 'string'
    ? body.message
    : (body.message?.body || body.body || body.last_message || body.text || '');

  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const audioRaw = body.audio_url || body.audioUrl || attachments.find(a => /audio|ogg|mp3|wav/i.test(String(a?.type || a)))?.url || '';
  const imageRaw = body.image_url || body.imageUrl || attachments.find(a => /image|jpg|jpeg|png|webp/i.test(String(a?.type || a)))?.url || '';

  return buildInboundEvent({
    instance: 'ghl',
    externalId: contactId,
    rawPhone,
    pushName: body.full_name || body.name || [body.first_name, body.last_name].filter(Boolean).join(' '),
    text: rawText,
    audioUrl: typeof audioRaw === 'string' ? audioRaw : (audioRaw?.url || ''),
    imageUrl: typeof imageRaw === 'string' ? imageRaw : (imageRaw?.url || ''),
  });
}

async function ghlRequest(token, method, path, payload, { version = config.ghlApiVersion || '2021-04-15', fetchFn = fetch } = {}) {
  const res = await fetchFn(`${GHL_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: version,
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`GoHighLevel ${method} ${path} -> ${res.status}: ${text}`), {
      code: `ghl_http_${res.status}`,
    });
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Envia mensagem WhatsApp para um contato via GoHighLevel Conversations API v2.
 */
export async function sendGhlText(phoneOrJid, text, {
  token = config.ghlToken,
  version = config.ghlApiVersion,
  contactId = null,
  fetchFn = fetch,
} = {}) {
  if (!token) {
    throw new Error('GoHighLevel não configurado (GHL_API_TOKEN)');
  }
  const targetId = String(contactId || getGhlContact(phoneOrJid)?.contactId || '').trim();
  if (!targetId) {
    throw new Error(`contactId do GoHighLevel não encontrado para ${cleanJidPhone(phoneOrJid) || 'contato'}`);
  }

  return ghlRequest(token, 'POST', '/conversations/messages', {
    type: 'WhatsApp',
    contactId: targetId,
    message: String(text || ''),
  }, { version, fetchFn });
}

/**
 * Adiciona tag de handoff no contato do GoHighLevel.
 */
export async function tagGhlHandoff(phoneOrJid, {
  token = config.ghlToken,
  version = config.ghlApiVersion,
  transferTag = config.ghlTransferTag,
  contactId = null,
  fetchFn = fetch,
} = {}) {
  if (!token) throw new Error('GHL_API_TOKEN não configurado');
  const targetId = String(contactId || getGhlContact(phoneOrJid)?.contactId || '').trim();
  if (!targetId) return null;

  return ghlRequest(token, 'POST', `/contacts/${encodeURIComponent(targetId)}/tags`, {
    tags: [transferTag || 'transferido-humano'],
  }, { version, fetchFn });
}

/**
 * Atualiza a etapa (stage) de uma oportunidade no pipeline do GoHighLevel.
 */
export async function updateGhlOpportunityStage(opportunityId, stageId, {
  token = config.ghlToken,
  version = config.ghlApiVersion,
  pipelineId = undefined,
  fetchFn = fetch,
} = {}) {
  if (!token) throw new Error('GHL_API_TOKEN não configurado');
  if (!opportunityId || !stageId) throw new Error('opportunityId e stageId são obrigatórios');

  const body = { pipelineStageId: String(stageId) };
  if (pipelineId) body.pipelineId = String(pipelineId);

  return ghlRequest(token, 'PUT', `/opportunities/${encodeURIComponent(opportunityId)}`, body, {
    version,
    fetchFn,
  });
}
