import { filterReply } from '../safety.mjs';

const DEFAULT_SURVEY = 'Obrigado pelo contato! De 1 a 5, como você avalia nosso atendimento hoje?';

function sanitizeReply(text) {
  const filtered = filterReply(String(text || ''), { strictPrices: false });
  return typeof filtered === 'string' ? filtered : (filtered?.text || String(text || ''));
}

/**
 * Envia a pesquisa de satisfação pós-atendimento (1 a 5) se habilitada e ainda não enviada.
 */
export async function sendReputationSurvey({ session, phone, sendText, reputationConfig = {} }) {
  if (!reputationConfig?.enabled || !session || typeof sendText !== 'function') {
    return { sent: false, reason: 'disabled_or_invalid' };
  }
  if (session.reputationSentAt) {
    return { sent: false, reason: 'already_sent' };
  }

  const msg = sanitizeReply(reputationConfig.surveyMessage || DEFAULT_SURVEY);
  const target = session.jid || session.phone || phone;
  await sendText(target, msg);

  session.reputationAwaitingRating = true;
  session.reputationSentAt = new Date().toISOString();
  return { sent: true };
}

/**
 * Processa a resposta de nota (1 a 5) de um contato aguardando avaliação.
 * Notas >= minPositiveRating recebem o link do Google Meu Negócio (se configurado).
 */
export async function handleReputationReply({ session, text, phone, sendText, reputationConfig = {} }) {
  if (!session?.reputationAwaitingRating || typeof sendText !== 'function') {
    return { handled: false };
  }

  const match = String(text || '').trim().match(/^([1-5])(?:\s*[⭐★]|\s*\/\s*5)?$/);
  if (!match) {
    return { handled: false };
  }

  const rating = Number(match[1]);
  const minPositive = Number(reputationConfig.minPositiveRating || 4);
  const googleUrl = String(reputationConfig.googleReviewUrl || '').trim();
  const positive = rating >= minPositive;

  session.reputationAwaitingRating = false;
  session.reputationRating = rating;
  session.reputationRatedAt = new Date().toISOString();

  const replyText = positive && googleUrl
    ? `Que ótimo saber! Muito obrigado pela nota ${rating}/5. Se puder deixar sua avaliação no Google, ajuda muito nosso trabalho: ${googleUrl}`
    : positive
      ? `Muito obrigado pela nota ${rating}/5! Ficamos à disposição sempre que precisar.`
      : `Agradecemos sua sinceridade (nota ${rating}/5). Vamos usar seu retorno para melhorar nosso atendimento.`;

  const target = session.jid || session.phone || phone;
  await sendText(target, sanitizeReply(replyText));
  return { handled: true, rating, positive };
}
