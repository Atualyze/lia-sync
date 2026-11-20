const DECISIONS = new Set(['approve', 'cancel', 'inspect', 'resolve', 'none']);

function readRawResult(result) {
  if (typeof result === 'string') return result.trim();
  return String(result?.reply || result?.text || result?.content || '').trim();
}

export function parsePendingOutboundIntent(result) {
  const raw = readRawResult(result);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { intent: 'none', confidence: 0, reason: 'invalid_response' };
  try {
    const parsed = JSON.parse(match[0]);
    const intent = String(parsed.intent || '').trim().toLowerCase();
    if (!DECISIONS.has(intent)) throw new Error('invalid_intent');
    const confidence = Number(parsed.confidence);
    return {
      intent,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      reason: String(parsed.reason || '').trim().slice(0, 180)
    };
  } catch {
    return { intent: 'none', confidence: 0, reason: 'invalid_response' };
  }
}

/**
 * Interprets natural-language decisions about an existing outbound dispatch.
 * This layer only classifies intent. It never sends, retries, or changes state.
 */
export async function classifyPendingOutboundIntent({
  ai,
  message = '',
  pending = null,
  recentContext = [],
  botConfig = {},
  deadline
} = {}) {
  if (!pending || !String(message || '').trim() || !ai?.askAI) {
    return { intent: 'none', confidence: 0, reason: 'unavailable' };
  }

  const payload = {
    latestUserMessage: String(message).slice(0, 2000),
    pendingDispatch: {
      id: String(pending.id || '').slice(0, 40),
      recipient: String(pending.recipient || '').slice(0, 120),
      phone: String(pending.phone || '').slice(0, 40),
      message: String(pending.message || '').slice(0, 1000),
      status: String(pending.status || '').slice(0, 40),
      createdAt: String(pending.createdAt || '').slice(0, 80)
    },
    recentContext: (Array.isArray(recentContext) ? recentContext : []).slice(-6).map(item => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: String(item?.content || '').slice(0, 700)
    }))
  };

  const system = [
    'Você interpreta a intenção do responsável sobre um disparo WhatsApp que já existe.',
    'Não execute nenhuma ação. Apenas classifique a mensagem atual.',
    'Entenda português natural, abreviações, erros de digitação e referências como "esse disparo", "isso", "o anterior" e "essa pendência".',
    'approve: o responsável quer autorizar/enviar o disparo agora. Isso inclui formas naturais como "pode mandar", "manda esse", "pode seguir com esse envio".',
    'cancel: o responsável quer cancelar/descartar o disparo.',
    'inspect: o responsável quer saber detalhes, estado, destinatário ou o que foi preparado.',
    'resolve: o responsável quer encerrar, dar baixa, marcar como resolvido/concluído ou assumir manualmente a pendência sem pedir novo envio.',
    'none: conversa casual, dúvida sem decisão ou intenção que não corresponda a essas ações.',
    'IMPORTANTE: "resolve" não significa que a mensagem foi entregue. É apenas uma intenção de encerrar a pendência administrativa. A camada de segurança decidirá se e como isso pode ser registrado.',
    'Não trate perguntas como autorização. Não confunda "não envie", "não precisa enviar" ou "não entendi" com approve.',
    'Responda exclusivamente JSON válido: {"intent":"approve|cancel|inspect|resolve|none","confidence":0.0,"reason":"motivo curto"}'
  ].join('\n');

  try {
    const result = await ai.askAI({
      system,
      history: [],
      userText: JSON.stringify(payload),
      botConfig,
      isOwner: true,
      autoRouting: false,
      disableToolCalling: true,
      deadline
    });
    const parsed = parsePendingOutboundIntent(result);
    if (parsed.intent !== 'none' && parsed.confidence < 0.72) {
      return { ...parsed, intent: 'none', reason: 'low_confidence' };
    }
    return parsed;
  } catch {
    return { intent: 'none', confidence: 0, reason: 'classification_failed' };
  }
}
