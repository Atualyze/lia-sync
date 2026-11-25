import { validateClientReminderRequest } from './client-reminder-guard.mjs';

const isScheduleToolCall = call => {
  const name = String(call?.name || '').trim();
  return name === 'agendar_retorno_ou_followup'
    || (name === 'gerenciar_agenda_google' && call?.args?.action === 'criar_evento');
};

/**
 * Normaliza lembretes propostos pelo Copiloto do responsável para uma única
 * criação de evento no Google Calendar. O texto, assunto, data e hora precisam
 * estar fundamentados na mensagem atual; caso contrário, nenhuma ferramenta
 * de escrita é autorizada.
 */
export function prepareOwnerReminderCalendarCall({
  message = '',
  reminder = null,
  toolCalls = [],
  now = Date.now(),
  timezone = 'America/Sao_Paulo'
} = {}) {
  const calls = Array.isArray(toolCalls) ? [...toolCalls] : [];
  const legacyReminderCall = calls.find(call => call?.name === 'agendar_retorno_ou_followup');
  const candidate = reminder || (legacyReminderCall
    ? { text: legacyReminderCall.args?.reason, dueAt: legacyReminderCall.args?.when }
    : null);

  if (!candidate) return { state: 'none', toolCalls: calls, reminder: null };

  const summary = String(candidate.text || '').trim();
  const dueAtValue = String(candidate.dueAt || '').trim();
  const gate = validateClientReminderRequest({
    message,
    reason: summary,
    when: dueAtValue,
    now
  });
  const retainedCalls = calls.filter(call => !isScheduleToolCall(call));

  if (!gate.allowed) {
    return {
      state: 'clarification',
      code: gate.code,
      reply: gate.reply,
      reminder: null,
      toolCalls: retainedCalls
    };
  }

  const dueAt = new Date(dueAtValue);
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(dueAt).map(part => [part.type, part.value]));
  const timeParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(dueAt).map(part => [part.type, part.value]));

  return {
    state: 'ready',
    reminder: null,
    toolCalls: [
      ...retainedCalls,
      {
        name: 'gerenciar_agenda_google',
        args: {
          action: 'criar_evento',
          date: `${dateParts.year}-${dateParts.month}-${dateParts.day}`,
          startTime: `${timeParts.hour}:${timeParts.minute}`,
          summary
        }
      }
    ]
  };
}
