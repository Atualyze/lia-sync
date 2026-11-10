import { config } from '../config.mjs';

export async function transcribeAudio(base64, mimetype = 'audio/ogg') {
  if (!config.geminiKey || !base64) return null;
  const cleanMime = String(mimetype).split(';')[0].trim() || 'audio/ogg';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${config.geminiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: cleanMime, data: base64 } },
            { text: "Transcreva este áudio em português com fidelidade total. Retorne apenas o texto transcrito, sem introduções ou explicações." }
          ]
        }]
      })
    });
    if (!res.ok) {
      console.error('[ai] transcribeAudio status:', res.status);
      return null;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? text.trim() : null;
  } catch (e) {
    console.error('[ai] transcribeAudio erro:', e.message);
    return null;
  }
}

export async function synthesizeVoice(text, { voiceName = 'Aoede', botConfig = {} } = {}) {
  if (!config.geminiKey || !text) return null;
  const selectedVoice = botConfig?.voice?.voiceName || voiceName || 'Aoede';
  const cleanText = String(text)
    .replace(/[*_#`~]/g, '')
    .replace(/https?:\/\/\S+/g, 'link enviado')
    .replace(/[•\-\+]\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanText) return null;

  const ttsModels = [
    'gemini-3.8-flash-lite-tts',
    'gemini-3.8-flash-tts',
    'gemini-2.5-flash-preview-tts'
  ];

  const payload = {
    contents: [
      { parts: [{ text: cleanText }] }
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
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
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
          return { base64: p.inlineData.data, mimeType: p.inlineData.mimeType || 'audio/wav', voiceName: selectedVoice };
        }
      }
    } catch (err) {
      console.warn(`[ai] synthesizeVoice (${model}) erro:`, err.message);
    }
  }

  return null;
}
