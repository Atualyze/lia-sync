import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.mjs';
import { resolveIdentity } from '../core/identity.mjs';

const execFileAsync = promisify(execFile);
const DOCUMENT_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-3.8-flash'];

export async function extractPdfTextWithPoppler(base64, { timeoutMs = 5000, maxChars = 16000 } = {}) {
  const cleanB64 = String(base64 || '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleanB64) return '';
  const tmpFile = path.join(os.tmpdir(), `lia-doc-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`);
  try {
    await fs.writeFile(tmpFile, Buffer.from(cleanB64, 'base64'));
    const { stdout } = await execFileAsync('pdftotext', ['-layout', '-nopgbrk', tmpFile, '-'], {
      timeout: timeoutMs,
      maxBuffer: 512 * 1024
    });
    const text = String(stdout || '').replace(/\r\n/g, '\n').trim();
    return text.slice(0, maxChars);
  } catch {
    return '';
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }
}

/**
 * Analisa documentos, contratos, comprovantes (PIX/TED) e briefings em PDF/Imagem com pdftotext + Gemini Flash multimodal
 */
export async function analyzeDocument({ base64, mimetype = 'application/pdf', caption = '', identity = {}, botConfig = {} }) {
  if (!base64) return null;
  const cleanB64 = String(base64).replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleanB64) return null;
  const identityInfo = resolveIdentity(identity && Object.keys(identity).length ? identity : botConfig);
  const assistant = identityInfo.botName || 'Lia';
  const owner = identityInfo.responsible || 'nossa equipe';
  const cleanMime = String(mimetype).split(';')[0].trim() || 'application/pdf';

  let extractedPdfText = '';
  if (cleanMime === 'application/pdf') {
    extractedPdfText = await extractPdfTextWithPoppler(cleanB64);
  }

  const geminiKeys = [...new Set([config.geminiFreeKey, config.geminiKey].filter(Boolean))];
  const promptText = `Você é a ${assistant}, IA assistente executiva de ${owner}${identityInfo.companyName ? ` (${identityInfo.companyName})` : ''}.
Analise este documento ou imagem em anexo com máxima fidelidade, precisão e síntese executiva.
Identifique com precisão se é comprovante de pagamento (PIX, TED, boleto), contrato, briefing, proposta, planilha, certidão ou imagem informativa.
Se for comprovante de pagamento, extraia obrigatoriamente: valor (R$), pagador, favorecido/destinatário, data/hora e id/autenticação se existirem.
Retorne um JSON estrito no seguinte formato:
{
  "summary": "Resumo executivo claro e completo em 2 a 5 linhas em português do Brasil.",
  "docType": "comprovante_pix | comprovante_ted | comprovante_boleto | contrato | briefing | proposta | certidao | imagem | documento_geral",
  "paymentDetails": {
    "isPayment": true/false,
    "amount": "R$ 0,00 ou null",
    "payer": "Nome ou null",
    "receiver": "Nome ou null",
    "date": "Data ou null",
    "txId": "Código/Autenticação ou null"
  },
  "keyPoints": ["Ponto 1 (valores, partes, itens ou objeto)", "Ponto 2 (prazos, datas ou condições)", "Ponto 3 (dados relevantes extraídos do texto/OCR)"],
  "actionNeeded": "Ação recomendada para ${owner} ou resposta sugerida."
}
${caption ? `Contexto/Pedido enviado junto ao arquivo: "${caption}"` : ''}`;

  const parseDocJson = (raw) => {
    const cleaned = String(raw || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    if (!cleaned) return null;
    try { return JSON.parse(cleaned); } catch {}
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); } catch {}
    }
    return { summary: cleaned.slice(0, 1200), docType: 'documento_geral', keyPoints: [], actionNeeded: 'Revisar anexo' };
  };

  for (const apiKey of geminiKeys) {
    for (const model of DOCUMENT_MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey
          },
        signal: AbortSignal.timeout(config.aiTimeoutMs || 30000),
        body: JSON.stringify({
          contents: [{
            parts: extractedPdfText.length >= 20
              ? [{ text: `${promptText}\n\nTexto extraído do PDF via pdftotext:\n"""\n${extractedPdfText}\n"""` }]
              : [
                  { inlineData: { mimeType: cleanMime, data: cleanB64 } },
                  { text: promptText }
                ]
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1
          }
        })
      });
        if (!res.ok) {
          if (res.status === 404 || res.status === 400 || res.status === 429 || res.status >= 500) continue;
          console.error('[ai] analyzeDocument status:', res.status);
          break;
        }
      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) continue;
      const parsed = parseDocJson(raw);
      if (parsed) return parsed;
      } catch (e) {
        console.error(`[ai] analyzeDocument erro (${model}):`, e.message);
      }
    }
  }

  // Fallback universal para imagens (fotos, prints, comprovantes) e PDFs extraídos via Groq / OpenRouter
  const isImage = cleanMime.startsWith('image/');
  const visionCandidates = [];
  if (isImage && config.groqKey) {
    visionCandidates.push({
      name: 'groq-vision',
      url: `${config.groqBaseUrl}/chat/completions`,
      key: config.groqKey,
      model: 'meta-llama/llama-4-scout-17b-16e-instruct'
    });
  }
  if (isImage && config.openrouterKey) {
    visionCandidates.push({
      name: 'openrouter-vision',
      url: `${config.openrouterBaseUrl}/chat/completions`,
      key: config.openrouterKey,
      model: 'openrouter/free'
    });
  }
  if (!isImage && extractedPdfText.length >= 20 && config.groqKey) {
    visionCandidates.push({
      name: 'groq-pdf-summary',
      url: `${config.groqBaseUrl}/chat/completions`,
      key: config.groqKey,
      model: 'llama-3.3-70b-versatile'
    });
  }

  for (const cand of visionCandidates) {
    try {
      const userContent = isImage
        ? [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: `data:${cleanMime};base64,${cleanB64}` } }
          ]
        : `${promptText}\n\nTexto extraído do PDF via pdftotext:\n"""\n${extractedPdfText.slice(0, 14000)}\n"""`;
      const res = await fetch(cand.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${cand.key}`
        },
        signal: AbortSignal.timeout(config.aiTimeoutMs || 30000),
        body: JSON.stringify({
          model: cand.model,
          temperature: 0.1,
          max_tokens: 1500,
          messages: [{ role: 'user', content: userContent }]
        })
      });
      if (!res.ok) continue;
      const data = await res.json().catch(() => ({}));
      const raw = data?.choices?.[0]?.message?.content;
      const parsed = parseDocJson(raw);
      if (parsed) {
        if (extractedPdfText.length >= 20 && !parsed.extractedText) {
          parsed.extractedText = extractedPdfText;
        }
        return parsed;
      }
    } catch (e) {
      console.error(`[ai] analyzeDocument fallback erro (${cand.name}):`, e.message);
    }
  }

  if (extractedPdfText.length >= 20) {
    return {
      summary: extractedPdfText.slice(0, 420),
      docType: 'documento_geral',
      keyPoints: extractedPdfText.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 5),
      extractedText: extractedPdfText,
      extractionSource: 'pdftotext',
      actionNeeded: 'Revisar texto extraído localmente via pdftotext.'
    };
  }
  return null;
}
