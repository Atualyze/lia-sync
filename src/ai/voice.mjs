import { config } from '../config.mjs';

const TRANSCRIBE_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-3.8-flash'];

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

export async function transcribeAudio(base64, mimetype = 'audio/ogg', { timeoutMs = 45000 } = {}) {
  if (!config.geminiKey || !base64) return null;
  const cleanB64 = String(base64).replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleanB64) return null;
  const cleanMime = String(mimetype).split(';')[0].trim() || 'audio/ogg';
  for (const model of TRANSCRIBE_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.geminiKey
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
        if (res.status === 404 || res.status === 400 || res.status >= 500) continue;
        console.error('[ai] transcribeAudio status:', res.status);
        return null;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text && text.trim()) return text.trim();
    } catch (e) {
      console.error(`[ai] transcribeAudio erro (${model}):`, e.message);
    }
  }
  return null;
}

export async function synthesizeVoice(text, { voiceName = 'Aoede', botConfig = {} } = {}) {
  if (!config.geminiKey || !text) return null;
  const selectedVoice = botConfig?.voice?.voiceName || voiceName || 'Aoede';
  const timeoutMs = Math.max(5000, Math.min(120000, Number(botConfig?.voice?.requestTimeoutMs) || 45000));
  const cleanText = String(text)
    .replace(/[*_#`~]/g, '')
    .replace(/https?:\/\/\S+/g, 'link enviado')
    .replace(/[•\-\+]\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanText) return null;

  const ttsModels = [
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-pro-preview-tts'
  ];

  const payload = {
    contents: [
      { parts: [{ text: cleanText }] }
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: selectedVoice
          }
        }
      }
    }
  };

  for (const model of ttsModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.geminiKey
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        console.warn(`[ai] synthesizeVoice (${model}) HTTP erro ${res.status}:`, err.slice(0, 150));
        continue;
      }
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) {
          const rawMime = String(p.inlineData.mimeType || 'audio/L16;rate=24000');
          const rateMatch = rawMime.match(/rate=(\d+)/i);
          const sampleRate = rateMatch ? Number(rateMatch[1]) || 24000 : 24000;
          const isRawPcm = /audio\/(?:l16|pcm)/i.test(rawMime) || !rawMime.includes('/');
          const finalBase64 = isRawPcm ? pcm16ToWavBase64(p.inlineData.data, sampleRate) : pcm16ToWavBase64(p.inlineData.data, sampleRate);
          return { base64: finalBase64, mimeType: 'audio/wav', voiceName: selectedVoice };
        }
      }
    } catch (err) {
      console.warn(`[ai] synthesizeVoice (${model}) erro:`, err.message);
    }
  }

  return null;
}
