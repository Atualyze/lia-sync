import crypto from 'node:crypto';
import { cleanJidPhone } from '../sessions.mjs';

/**
 * Constrói o evento normalizado `MESSAGES_UPSERT` esperado por `processWhatsAppWebhookPayload`
 * a partir de qualquer provedor externo (ManyChat, GoHighLevel, etc.).
 */
export function buildInboundEvent({
  instance,
  externalId = '0',
  rawPhone = '',
  pushName = '',
  text = '',
  audioUrl = '',
  imageUrl = '',
} = {}) {
  const phone = cleanJidPhone(rawPhone);
  const message = {};
  const cleanText = String(text || '').trim();

  if (cleanText) {
    message.conversation = cleanText;
  } else if (audioUrl) {
    message.audioMessage = { url: String(audioUrl) };
  } else if (imageUrl) {
    message.imageMessage = { url: String(imageUrl) };
  }

  return {
    event: 'MESSAGES_UPSERT',
    instance: String(instance || 'external'),
    data: {
      key: {
        id: `${instance || 'ext'}_${externalId || '0'}_${crypto.randomUUID()}`,
        remoteJid: phone ? `${phone}@s.whatsapp.net` : '',
        fromMe: false,
      },
      pushName: String(pushName || '').trim() || undefined,
      messageTimestamp: Math.floor(Date.now() / 1000),
      message,
    },
  };
}
