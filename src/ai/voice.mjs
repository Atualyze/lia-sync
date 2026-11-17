import { config } from '../config.mjs';

const TRANSCRIBE_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash'];

const GEMINI_VOICE_MAP = {
  'Aoede': 'Aoede',
  'Kore': 'Kore',
  'Leda': 'Leda',
  'Zephyr': 'Zephyr',
  'Puck': 'Puck',
  'Charon': 'Charon',
  'Fenrir': 'Fenrir',
  'pt-BR-FranciscaNeural': 'Aoede',
  'pt-BR-ThalitaNeural': 'Kore',
  'pt-BR-AntonioNeural': 'Puck'
};

/**
 * Normaliza texto para síntese de fala natural em português brasileiro (pt-BR),
 * removendo marcações visuais, emojis e siglas truncadas que geram leitura robótica.
 */
export function prepareSpeechText(rawText, maxChars = 750) {
  if (!rawText) return '';
  let text = String(rawText)
    // Remove blocos de código e formatação Markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#`~>]/g, '')
    // Substitui URLs por fala natural
    .replace(/https?:\/\/\S+/gi, 'no link enviado')
    // Remove emojis e pictogramas Unicode para evitar leitura literal pelo TTS
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, ' ')
    // Converte marcadores de lista em pausas naturais de fala
    .replace(/(?:^|\n)\s*[•▸▪\-\+]\s+/g, '. ')
    // Normaliza valores monetários em reais
    .replace(/R\$\s*(\d+(?:\.\d{3})*),(\d{2})/g, (_, intPart, cents) => {
      const cleanInt = intPart.replace(/\./g, '');
      return Number(cents) > 0 ? `${cleanInt} reais e ${Number(cents)} centavos` : `${cleanInt} reais`;
    })
    .replace(/R\$\s*(\d+)/g, '$1 reais')
    // Expande abreviações comuns em português brasileiro
    .replace(/\bDr\.\s*/gi, 'Doutor ')
    .replace(/\bDra\.\s*/gi, 'Doutora ')
    .replace(/\bSr\.\s*/gi, 'Senhor ')
    .replace(/\bSra\.\s*/gi, 'Senhora ')
    .replace(/\bn[º°]\s*/gi, 'número ')
    .replace(/(\d+)\s*%/g, '$1 por cento')
    .replace(/\n+/g, '. ')
    .replace(/\s*\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > maxChars) {
    const sliced = text.slice(0, maxChars);
    const lastPeriod = Math.max(sliced.lastIndexOf('. '), sliced.lastIndexOf('! '), sliced.lastIndexOf('? '));
    text = lastPeriod > maxChars * 0.55 ? sliced.slice(0, lastPeriod + 1).trim() : `${sliced.trim()}.`;
  }
  return text;
}

/**
 * Empacota áudio PCM 16-bit mono cru (audio/L16 retornado pelo Gemini TTS) em container WAV válido (44 bytes de header).
 */
export function pcm16ToWavBase64(rawBase64, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const pcmBuf = Buffer.from(String(rawBase64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (pcmBuf.length >= 4) {
    const magic = pcmBuf.subarray(0, 4).toString('ascii');
    if (magic === 'RIFF' || magic === 'OggS' || magic.startsWith('ID3') || (pcmBuf[0] === 0xff && (pcmBuf[1] & 0xe0) === 0xe0)) {
      return pcmBuf.toString('base64');
    }
  }
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuf.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  header.writeUInt32LE ? null : null;
  header.writeUInt16LE(1, 20);  // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuf]).toString('base64');
}

/**
 * Status do runtime de voz. Síntese 100% Gemini API; sem motores offline desde a remoção do Piper.
 */
export function getVoiceRuntimeStatus() {
  return { offlineAvailable: false, engine: 'gemini-neural-pt-br', models: [] };
}

async function transcribeWithGroqWhisper(cleanB64, cleanMime, timeoutMs = 45000) {
  if (!config.groqKey || !cleanB64) return null;
  const ext = cleanMime.includes('mp4') || cleanMime.includes('m4a') ? 'm4a'
    : cleanMime.includes('mpeg') || cleanMime.includes('mp3') ? 'mp3'
    : cleanMime.includes('wav') ? 'wav'
    : 'ogg';
  try {
    const buffer = Buffer.from(cleanB64, 'base64');
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: cleanMime }), `audio.${ext}`);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'pt');
    form.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.groqKey}` },
      signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 45000)),
      body: form
    });
    if (!res.ok) {
      console.warn('[ai] groq whisper status:', res.status);
      return null;
    }
    const data = await res.json().catch(() => ({}));
    return data?.text && String(data.text).trim() ? String(data.text).trim() : null;
  } catch (e) {
    console.warn('[ai] groq whisper aviso:', e.message);
    return null;
  }
}

export async function transcribeAudio(base64, mimetype = 'audio/ogg', { timeoutMs = 45000 } = {}) {
  if (!base64) return null;
  const cleanB64 = String(base64).replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleanB64) return null;
  const cleanMime = String(mimetype).split(';')[0].trim() || 'audio/ogg';

  // 1. Groq Whisper Free Tier (rápido e gratuito quando GROQ_API_KEY está configurada)
  const groqText = await transcribeWithGroqWhisper(cleanB64, cleanMime, timeoutMs);
  if (groqText) return groqText;

  // 2. Fallback automático para Gemini multimodal (usa chave gratuita primeiro, depois paga)
  const geminiKeys = [...new Set([config.geminiFreeKey, config.geminiKey].filter(Boolean))];
  if (!geminiKeys.length) return null;
  for (const apiKey of geminiKeys) {
    for (const model of TRANSCRIBE_MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey
          },
          signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 45000)),
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType: cleanMime, data: cleanB64 } },
                { text: 'Transcreva este áudio em português com fidelidade total. Retorne apenas o texto transcrito, sem introduções ou explicações.' }
              ]
            }]
          })
        });
        if (!res.ok) {
          if (res.status === 404 || res.status === 400 || res.status === 429 || res.status >= 500) continue;
          console.error('[ai] transcribeAudio status:', res.status);
          break;
        }
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim()) return text.trim();
      } catch (e) {
        console.error(`[ai] transcribeAudio erro (${model}):`, e.message);
      }
    }
  }
  return null;
}

export async function synthesizeVoice(text, { voiceName = '', botConfig = {} } = {}) {
  if (!text) return null;
  const explicitVoice = typeof voiceName === 'string' ? voiceName.trim() : '';
  const selectedVoice = explicitVoice || botConfig?.voice?.voiceName || 'Aoede';
  const speed = Number(botConfig?.voice?.speed) || 1.0;
  const maxChars = Math.max(120, Math.min(2000, Number(botConfig?.voice?.maxTextChars) || 750));
  const timeoutMs = Math.max(5000, Math.min(120000, Number(botConfig?.voice?.requestTimeoutMs) || 45000));
  const cleanText = prepareSpeechText(text, maxChars);
  if (!cleanText) return null;
  // Motor Neural Gemini 2.5 com trava estrita de identidade vocal PT-BR (sem troca de modelo acústico)
  if (config.geminiKey) {
    const geminiVoice = GEMINI_VOICE_MAP[selectedVoice] || 'Aoede';
    // Usa exclusivamente o checkpoint primário para nunca alternar timbre entre mensagens
    const primaryTtsModel = 'gemini-2.5-flash-preview-tts';
    const directedPrompt = `Fale em português do Brasil (pt-BR) com voz humana brasileira natural, fluida, acolhedora e timbre fixo consistente, lendo exatamente o seguinte texto: ${cleanText}`;

    const payload = {
      contents: [
        { parts: [{ text: directedPrompt }] }
      ],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode: 'pt-BR',
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: geminiVoice
            }
          }
        }
      }
    };

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(primaryTtsModel)}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.geminiKey
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
          if (p.inlineData?.data) {
            const rawMime = String(p.inlineData.mimeType || 'audio/L16;rate=24000');
            const rateMatch = rawMime.match(/rate=(\d+)/i);
            const sampleRate = rateMatch ? Number(rateMatch[1]) || 24000 : 24000;
            const finalBase64 = pcm16ToWavBase64(p.inlineData.data, sampleRate);
            return {
              base64: finalBase64,
              mimeType: 'audio/wav',
              voiceName: selectedVoice,
              engine: 'gemini-neural-pt-br'
            };
          }
        }
      } else {
        const err = await res.text().catch(() => '');
        console.warn(`[ai] synthesizeVoice (${primaryTtsModel}) HTTP ${res.status}:`, err.slice(0, 150));
      }
    } catch (err) {
      console.warn(`[ai] synthesizeVoice (${primaryTtsModel}) erro:`, err.message);
    }
  }
  return null;
}
