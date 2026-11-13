import { cleanForSpeech } from './text.mjs';

/**
 * Transcreve um áudio recebido do contato. Retorna null quando não há
 * transcrição possível (mídia indisponível, erro do provedor ou resposta vazia).
 */
export async function transcribeIncomingAudio({ whatsapp, ai, rawItem, botConfig = {} }) {
  try {
    const media = await whatsapp?.getMediaBase64?.(rawItem);
    if (media?.base64) {
      const text = await ai?.transcribeAudio?.(media.base64, media.mimetype, { timeoutMs: botConfig?.voice?.requestTimeoutMs });
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
  let voiceRes;
  try {
    const spokenReply = cleanForSpeech(text);
    if (!spokenReply || spokenReply.length < 2) return false;
    voiceRes = await ai.synthesizeVoice(spokenReply, { botConfig });
    if (!voiceRes?.base64) return false;
  } catch (err) {
    logger?.error?.('[flow:voice] Falha ao sintetizar áudio; usando fallback em texto:', err.message);
    return false;
  }
  try {
    await whatsapp.sendWhatsAppAudio(targetJid, voiceRes.base64);
    return true;
  } catch (err) {
    logger?.error?.('[flow:voice] Falha na entrega do áudio; não repetir por texto para evitar duplicidade:', err.code || err.name || 'send_failed');
    return err?.deliveryUnknown === true;
  }
}
