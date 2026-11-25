import { normalize } from '../safety.mjs';

const REMINDER_NOUN = /\b(?:lembretes?|tarefas?|retornos?|agendamentos?|afendamentos?|compromissos?|eventos?)\b/;
const COUNT_REQUEST = /\b(?:quantos?|quantas?|quantidade|contagem|conte)\b/;
const LIST_REQUEST = /\b(?:liste|listar|lista|listagem|listar|mostre|mostrar|ver|veja|consultar|consulta|quais|quais sao|meus|minhas)\b/;
const SCHEDULED_STATUS_QUESTION = /\b(?:o que|que)\s+(?:eu\s+)?(?:tem|ha|esta|ta|ficou)\s+(?:agendad[oa]s?|marcad[oa]s?|reservad[oa]s?)\b|\btem\s+(?:algo|algum|alguma|o que)\s+(?:agendad[oa]|marcad[oa]|reservad[oa])\b/;
const CONFIRM_REQUEST = /\b(?:poderia|pode|consegue|me ajuda a|quero|preciso)?\s*(?:me\s+)?confirmar\b|\bconfirma\s+(?:pra|para)\s+mim\b/;
const PRIOR_REMINDER_SUCCESS = /\b(?:lembrete|retorno|agendamento|compromisso)\b.{0,120}\b(?:agendad[oa]|registrad[oa]|criad[oa]|marcad[oa])\b|\b(?:agendad[oa]|registrad[oa]|criad[oa]|marcad[oa])\b.{0,120}\b(?:lembrete|retorno|agendamento|compromisso)\b/;

/**
 * Classifica consultas de lembretes do contato atual antes da IA.
 * A confirmação "pode confirmar?" só vira consulta quando a última resposta
 * da Lia realmente alegou que um lembrete/retorno tinha sido criado.
 */
export function detectClientReminderQuery(message = '', history = []) {
  const text = normalize(message);
  const asksToConfirm = CONFIRM_REQUEST.test(text);
  const previousAssistant = [...(Array.isArray(history) ? history : [])]
    .reverse()
    .find(entry => entry?.role === 'assistant')?.content || '';
  const hasPreviousReminderClaim = PRIOR_REMINDER_SUCCESS.test(normalize(previousAssistant));
  if (!text || (
    !REMINDER_NOUN.test(text)
    && !SCHEDULED_STATUS_QUESTION.test(text)
    && !(asksToConfirm && hasPreviousReminderClaim)
  )) return null;

  if (COUNT_REQUEST.test(text) && REMINDER_NOUN.test(text)) return 'contar';

  if (asksToConfirm && hasPreviousReminderClaim) return 'ultimo';

  if (SCHEDULED_STATUS_QUESTION.test(text)) return 'listar';
  if (REMINDER_NOUN.test(text) && (
    LIST_REQUEST.test(text)
    || /\b(?:o que|quais|tem|ha|existe|me mostra|me diga)\b/.test(text)
    || /^(?:lembretes?|agendamentos?|afendamentos?|compromissos?|eventos?)$/.test(text)
  )) return 'listar';

  return null;
}

function formatDueAt(value, timezone) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return 'data/horário não informado';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone || 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date);
}

/** Formata exclusivamente resultados reais da ferramenta de consulta. */
export function buildClientReminderQueryReply({
  query,
  result,
  timezone = 'America/Sao_Paulo'
} = {}) {
  if (!result?.success) {
    return 'Não consegui consultar os lembretes associados a este contato agora. Prefiro não chutar uma quantidade nem afirmar que a lista está vazia.';
  }

  if (query === 'contar') {
    const count = Number.isInteger(result.count) ? result.count : 0;
    if (count === 0) return 'Não há lembretes pendentes registrados neste contato no momento.';
    const noun = count === 1 ? 'lembrete pendente' : 'lembretes pendentes';
    return `Há *${count} ${noun}* registrado(s) neste contato.`;
  }

  if (query === 'ultimo') {
    const item = result.reminder;
    if (!item) return 'Consultei os registros e não encontrei lembretes pendentes associados a este contato.';
    return `Encontrei o lembrete pendente mais recente deste contato:\n\n• *Assunto:* ${item.text || 'Sem título'}\n• *Data:* ${formatDueAt(item.dueAt, timezone)}\n\nEsse é um registro do sistema de lembretes, não um evento do Google Agenda.`;
  }

  const items = Array.isArray(result.reminders) ? result.reminders : [];
  if (!items.length) return 'Consultei os registros e não há lembretes pendentes associados a este contato no momento.';

  const lines = items.slice(0, 15).map((item, index) =>
    `${index + 1}. *${item.text || 'Lembrete sem título'}* — ${formatDueAt(item.dueAt, timezone)}`
  );
  const totalCount = Number.isInteger(result.count) ? result.count : items.length;
  const remaining = totalCount > lines.length
    ? `\n\nMostrando ${lines.length} de ${totalCount} lembretes pendentes.`
    : '';
  return `📋 *Lembretes pendentes deste contato (${Number.isInteger(result.count) ? result.count : items.length}):*\n\n${lines.join('\n')}${remaining}\n\n_Esses registros pertencem ao sistema de lembretes; não são eventos do Google Agenda._`;
}
