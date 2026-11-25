const STOP_WORDS = new Set([
  'a', 'as', 'ao', 'aos', 'o', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'da', 'das',
  'do', 'dos', 'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'pra', 'pro', 'com',
  'sem', 'que', 'e', 'ou', 'me', 'minha', 'meu', 'voce', 'voces', 'por favor',
  'poderia', 'pode', 'quero', 'preciso', 'gostaria', 'guardar', 'guarde', 'anotar',
  'anote', 'registrar', 'registre', 'deixar', 'deixe', 'recado', 'lembrete',
  'lembrar', 'lembre', 'lembre-me', 'retorno', 'retornar', 'retorne', 'agendar',
  'agende', 'agenda', 'marcar', 'marque', 'programar', 'programe', 'follow', 'up',
  'hoje', 'amanha', 'depois', 'dia', 'as', 'horario', 'horarios', 'ligar', 'ligue',
  'liga', 'avisar', 'avise', 'avisa', 'contato', 'voltar'
]);

function normalizeReminderText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9:/\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasSubstantiveReasonInMessage(message, reason) {
  const sourceTokens = new Set(
    normalizeReminderText(message).match(/[a-z0-9]{3,}/g)?.filter(token => !STOP_WORDS.has(token) && !/^\d+$/.test(token)) || []
  );
  const reasonTokens = normalizeReminderText(reason)
    .match(/[a-z0-9]{3,}/g)
    ?.filter(token => !STOP_WORDS.has(token) && !/^\d+$/.test(token)) || [];
  return reasonTokens.some(token => sourceTokens.has(token));
}

function asksToLeaveGenericNote(message) {
  const text = normalizeReminderText(message);
  return /\b(?:guardar|guarde|anotar|anote|registrar|registre|deixar|deixe)\b.{0,45}\brecado\b/.test(text)
    || /\brecado\b.{0,45}\b(?:guardar|guarde|anotar|anote|registrar|registre|deixar|deixe)\b/.test(text);
}

/**
 * Fails closed before a customer message can create a scheduled reminder.
 * The action, subject, date and time must all be grounded in the customer's text.
 */
export function validateClientReminderRequest({ message = '', reason = '', when = '', now = Date.now() } = {}) {
  const text = normalizeReminderText(message);
  const scheduleRequested = /\b(?:agendar|agende|agenda|marcar|marque|programar|programe|lembrete|lembr\w*|retorno|retornar|retorne|follow[- ]?up|me liga|me ligue|ligue para mim|me avisa|me avise|avise|avisar|entrar em contato|voltar a falar)\b/.test(text);

  if (!scheduleRequested) {
    return {
      allowed: false,
      code: 'schedule_not_explicit',
      reply: asksToLeaveGenericNote(text)
        ? 'Claro! Qual recado você gostaria que eu guardasse?'
        : 'Você gostaria de deixar um recado ou agendar um retorno? Me conte o assunto para eu entender direitinho.'
    };
  }

  if (!hasSubstantiveReasonInMessage(text, reason)) {
    return {
      allowed: false,
      code: 'reminder_subject_missing',
      reply: 'Claro! Sobre qual assunto você gostaria que eu agendasse o retorno?'
    };
  }

  const hasDate = /\b(?:hoje|amanha|depois de amanha|dia\s+\d{1,2}(?:\/\d{1,2}(?:\/\d{2,4})?)?|segunda(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sabado|domingo|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|20\d{2}-\d{2}-\d{2}|(?:daqui a|em)\s+\d+\s+dias?)\b/.test(text);
  const hasTime = /\b(?:as\s+\d{1,2}(?::\d{2}|h\d{0,2})?|\d{1,2}:\d{2}|\d{1,2}h\d{0,2})\b/.test(text);

  if (!hasDate || !hasTime) {
    const missing = !hasDate && !hasTime
      ? 'o dia e o horário'
      : !hasDate ? 'o dia' : 'o horário';
    return {
      allowed: false,
      code: 'reminder_datetime_missing',
      reply: `Para agendar o retorno, qual é ${missing} que você prefere?`
    };
  }

  const dueAt = Date.parse(when);
  if (!Number.isFinite(dueAt) || dueAt <= Number(now)) {
    return {
      allowed: false,
      code: 'reminder_datetime_invalid',
      reply: 'A data e o horário precisam ser futuros. Qual dia e horário você prefere?'
    };
  }

  return { allowed: true, code: 'validated' };
}
