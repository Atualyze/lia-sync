import { config } from '../config.mjs';
import { resolveIdentity } from '../core/identity.mjs';

const DOCUMENT_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-3.8-flash'];

/**
 * Analisa documentos, contratos, comprovantes (PIX/TED) e briefings em PDF/Imagem com Gemini Flash multimodal
 */
export async function analyzeDocument({ base64, mimetype = 'application/pdf', caption = '', identity = {}, botConfig = {} }) {
  if (!config.geminiKey || !base64) return null;
  const cleanB64 = String(base64).replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleanB64) return null;
  const identityInfo = resolveIdentity(identity && Object.keys(identity).length ? identity : botConfig);
  const assistant = identityInfo.botName || 'Lia';
  const owner = identityInfo.responsible || 'nossa equipe';
  const cleanMime = String(mimetype).split(';')[0].trim() || 'application/pdf';
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

  for (const model of DOCUMENT_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.geminiKey
        },
        signal: AbortSignal.timeout(config.aiTimeoutMs || 30000),
        body: JSON.stringify({
          contents: [{
            parts: [
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
        if (res.status === 404 || res.status === 400 || res.status >= 500) continue;
        console.error('[ai] analyzeDocument status:', res.status);
        return null;
      }
      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) continue;
      try {
        return JSON.parse(raw);
      } catch {
        const cleaned = String(raw).replace(/```json|```/gi, '').trim();
        try {
          return JSON.parse(cleaned);
        } catch {
          return { summary: cleaned, docType: 'documento_geral', keyPoints: [], actionNeeded: 'Revisar anexo' };
        }
      }
    } catch (e) {
      console.error(`[ai] analyzeDocument erro (${model}):`, e.message);
    }
  }
  return null;
}
