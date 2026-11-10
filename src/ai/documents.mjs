import { config } from '../config.mjs';
import { resolveIdentity } from '../core/identity.mjs';

/**
 * Analisa documentos, contratos, comprovantes (PIX/TED) e briefings em PDF/Imagem com Gemini Flash multimodal
 */
export async function analyzeDocument({ base64, mimetype = 'application/pdf', caption = '', identity = {}, botConfig = {} }) {
  if (!config.geminiKey || !base64) return null;
  const identityInfo = resolveIdentity(identity && Object.keys(identity).length ? identity : botConfig);
  const assistant = identityInfo.botName || 'Lia';
  const owner = identityInfo.responsible || 'nossa equipe';
  const cleanMime = String(mimetype).split(';')[0].trim() || 'application/pdf';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${config.geminiKey}`;
  try {
    const promptText = `Você é a ${assistant}, IA assistente executiva de ${owner}${identityInfo.companyName ? ` (${identityInfo.companyName})` : ''}.
Analise este documento ou anexo com máxima fidelidade, precisão e síntese executiva.
Identifique com precisão se é comprovante de pagamento (PIX, TED, boleto), contrato, briefing, proposta ou certidão.
Se for comprovante de pagamento, extraia obrigatoriamente: valor (R$), pagador, favorecido/destinatário, data/hora e id/autenticação se existirem.
Retorne um JSON estrito no seguinte formato:
{
  "summary": "Resumo executivo claro em 2 a 4 linhas em português do Brasil.",
  "docType": "comprovante_pix | comprovante_ted | comprovante_boleto | contrato | briefing | proposta | certidao | documento_geral",
  "paymentDetails": {
    "isPayment": true/false,
    "amount": "R$ 0,00 ou null",
    "payer": "Nome ou null",
    "receiver": "Nome ou null",
    "date": "Data ou null",
    "txId": "Código/Autenticação ou null"
  },
  "keyPoints": ["Ponto 1 (valores, partes ou objeto)", "Ponto 2 (prazos ou condições)", "Ponto 3 (pendências ou observações)"],
  "actionNeeded": "Ação recomendada para ${owner} ou resposta sugerida ao cliente."
}
${caption ? `Contexto/Legenda enviada pelo cliente: "${caption}"` : ''}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: cleanMime, data: base64 } },
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
      console.error('[ai] analyzeDocument status:', res.status);
      return null;
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { summary: raw.trim(), docType: 'documento_geral', keyPoints: [], actionNeeded: 'Revisar anexo' };
    }
  } catch (e) {
    console.error('[ai] analyzeDocument erro:', e.message);
    return null;
  }
}
