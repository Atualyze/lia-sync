import { cleanForSpeech } from './text.mjs';

/**
 * Transcreve um áudio recebido do contato. Retorna null quando não há
 * transcrição possível (mídia indisponível, erro do provedor ou resposta vazia).
 */
export async function transcribeIncomingAudio({ whatsapp, ai, rawItem }) {
  try {
    const media = await whatsapp?.getMediaBase64?.(rawItem);
    if (media?.base64) {
      const text = await ai?.transcribeAudio?.(media.base64, media.mimetype);
      return typeof text === 'string' ? text : null;
    }
  } catch (e) {
    console.error('[flow] Erro na transcrição de áudio:', e.message);
  }
  return null;
}

/**
 * Sintetiza a resposta em voz e envia como áudio no WhatsApp.
 * Retorna true somente quando o áudio foi realmente enviado.
 */
export async function sendVoiceReply({ ai, whatsapp, botConfig, logger, text, targetJid }) {
  if (!ai?.synthesizeVoice || !whatsapp?.sendWhatsAppAudio) return false;
  try {
    const spokenReply = cleanForSpeech(text);
    if (!spokenReply || spokenReply.length < 2) return false;
    const voiceRes = await ai.synthesizeVoice(spokenReply, { botConfig });
    if (!voiceRes?.base64) return false;
    await whatsapp.sendWhatsAppAudio(targetJid, voiceRes.base64);
    return true;
  } catch (err) {
    logger?.error?.('[flow:voice] Falha ao sintetizar/enviar áudio para o cliente, usando fallback em texto:', err.message);
    return false;
  }
}
