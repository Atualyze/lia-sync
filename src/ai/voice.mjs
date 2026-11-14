import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from '../config.mjs';

const TRANSCRIBE_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-3.8-flash'];

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
 * Detecta a disponibilidade do motor neural offline Piper ONNX no servidor/VPS.
 */
export function getVoiceRuntimeStatus() {
  const baseDirs = [
    process.env.PIPER_DATA_DIR,
    '/app/data/piper',
    path.resolve(process.cwd(), 'data/piper')
  ].filter(Boolean);

  for (const dir of baseDirs) {
    const binPath = path.join(dir, 'piper', 'piper');
    const faberModel = path.join(dir, 'pt_BR-faber-medium.onnx');
    const edressonModel = path.join(dir, 'pt_BR-edresson-low.onnx');
    const hasBin = fsSync.existsSync(binPath);
    const models = [];
    if (fsSync.existsSync(faberModel)) models.push('piper-pt-BR-faber');
    if (fsSync.existsSync(edressonModel)) models.push('piper-pt-BR-edresson');
    if (hasBin && models.length > 0) {
      return {
        offlineAvailable: true,
        engine: 'piper-onnx-x86_64',
        baseDir: dir,
        binPath,
        models
      };
    }
  }

  return {
    offlineAvailable: false,
    engine: 'gemini-neural-pt-br',
    baseDir: null,
    binPath: null,
    models: []
  };
}

/**
 * Executa síntese de voz neural 100% offline na CPU da VPS via Piper ONNX.
 */
async function synthesizeWithPiperOffline(cleanText, { voiceName = 'piper-pt-BR-faber', speed = 1.0, timeoutMs = 25000 } = {}) {
  const status = getVoiceRuntimeStatus();
  if (!status.offlineAvailable || !status.binPath || !status.baseDir) return null;

  const preferLow = voiceName === 'piper-pt-BR-edresson';
  const primaryFile = preferLow ? 'pt_BR-edresson-low.onnx' : 'pt_BR-faber-medium.onnx';
  const fallbackFile = preferLow ? 'pt_BR-faber-medium.onnx' : 'pt_BR-edresson-low.onnx';
  let modelPath = path.join(status.baseDir, primaryFile);
  if (!fsSync.existsSync(modelPath)) {
    modelPath = path.join(status.baseDir, fallbackFile);
  }
  if (!fsSync.existsSync(modelPath)) return null;

  const tmpWav = path.join(os.tmpdir(), `lia-piper-${crypto.randomUUID()}.wav`);
  const safeSpeed = Math.max(0.75, Math.min(1.35, Number(speed) || 1.0));
  const lengthScale = (1 / safeSpeed).toFixed(3);

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        status.binPath,
        ['--model', modelPath, '--output_file', tmpWav, '--length_scale', String(lengthScale)],
        {
          cwd: path.dirname(status.binPath),
          env: {
            ...process.env,
            LD_LIBRARY_PATH: `${path.dirname(status.binPath)}:${process.env.LD_LIBRARY_PATH || ''}`
          },
          stdio: ['pipe', 'ignore', 'pipe']
        }
      );

      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('piper_offline_timeout'));
      }, timeoutMs);

      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`piper_exit_${code}: ${stderr.slice(0, 140)}`));
      });

      child.stdin.write(`${cleanText}\n`);
      child.stdin.end();
    });

    const wavBuf = await fs.readFile(tmpWav);
    if (!wavBuf || wavBuf.length < 100) return null;
    return {
      base64: wavBuf.toString('base64'),
      mimeType: 'audio/wav',
      voiceName: voiceName.startsWith('piper-') ? voiceName : 'piper-pt-BR-faber',
      engine: 'piper-offline'
    };
  } catch (err) {
    console.warn('[ai] synthesizeWithPiperOffline aviso:', err.message);
    return null;
  } finally {
    await fs.rm(tmpWav, { force: true }).catch(() => {});
  }
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

  // 1. Se o usuário selecionou explicitamente uma voz neural offline Piper ONNX na VPS
  if (selectedVoice.startsWith('piper-')) {
    const offlineAudio = await synthesizeWithPiperOffline(cleanText, { voiceName: selectedVoice, speed, timeoutMs });
    if (offlineAudio) return offlineAudio;
  }

  // 2. Motor Neural Gemini 2.5 com trava estrita de identidade vocal PT-BR (sem troca de modelo acústico)
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

  // 3. Fallback Neural Offline Automático (Piper ONNX na VPS) caso a nuvem falhe ou atinja cota
  const fallbackOffline = await synthesizeWithPiperOffline(cleanText, {
    voiceName: 'piper-pt-BR-faber',
    speed,
    timeoutMs
  });
  if (fallbackOffline) return fallbackOffline;

  return null;
}
