import { validateClientReminderRequest } from './client-reminder-guard.mjs';

export function claimsUnverifiedCalendarCreation(reply = '') {
  const text = String(reply || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const claim = /\b(?:lembrete|retorno|compromisso|evento|agendamento)\b.{0,90}\b(?:agendad[oa]|agendei|criad[oa]|criei|salv[oa]|salvei|registrad[oa]|registrei|marcad[oa])\b|\b(?:agendei|agendamos|criei|salvei|registrei)\b.{0,80}\b(?:lembrete|retorno|compromisso|evento|agendamento)\b/.test(text);
  const explicitFailure = /\b(?:nao|nunca|jamais)\b.{0,80}\b(?:agendad[oa]|agendei|agendamos|criad[oa]|criei|salv[oa]|salvei|registrad[oa]|registrei|marcad[oa])\b/.test(text);
  return claim && !explicitFailure;
}

function isCalendarCreateCall(call) {
  return ['gerenciar_agenda_google', 'google_agenda'].includes(String(call?.name || '').trim())
    && call?.args?.action === 'criar_evento';
}

function isScheduleToolCall(call) {
  const name = String(call?.name || '').trim();
  return ['agendar_retorno_ou_followup', 'agendar_retorno'].includes(name)
    || isCalendarCreateCall(call);
}

function datePartsInTimezone(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]));
}

function dateHintToIso(rawDate, now, timezone) {
  const value = String(rawDate || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const localParts = datePartsInTimezone(new Date(now), timezone);
  const base = new Date(Date.UTC(Number(localParts.year), Number(localParts.month) - 1, Number(localParts.day)));
  if (/^(?:hoje|today|agora)$/.test(value)) return base.toISOString().slice(0, 10);
  if (/^(?:amanha|tomorrow)$/.test(value)) return new Date(base.getTime() + 86400000).toISOString().slice(0, 10);
  if (/^depois\s+de\s+amanha$/.test(value)) return new Date(base.getTime() + 2 * 86400000).toISOString().slice(0, 10);

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = value.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (br) {
    const year = br[3] ? (br[3].length === 2 ? `20${br[3]}` : br[3]) : localParts.year;
    return `${year}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  }
  return '';
}

function normalizeClock(rawTime) {
  const value = String(rawTime || '').trim().toLowerCase();
  const match = value.match(/^([01]?\d|2[0-3])(?::([0-5]\d)(?::[0-5]\d)?)?$|^([01]?\d|2[0-3])h([0-5]?\d)?$/);
  if (!match) return '';
  const hour = Number(match[1] || match[3]);
  const minute = Number(match[2] || match[4] || 0);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function toZonedIso(dateIso, time, timezone) {
  const [year, month, day] = dateIso.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = targetUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(guess)).map(part => [part.type, part.value]));
    const renderedUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute)
    );
    const delta = targetUtc - renderedUtc;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess).toISOString();
}

function localDateParts(now, timezone) {
  return datePartsInTimezone(new Date(now), timezone);
}

function explicitDateFromMessage(message, now, timezone) {
  const text = String(message || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const parts = localDateParts(now, timezone);
  const base = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const plusDays = days => new Date(base.getTime() + days * 86400000).toISOString().slice(0, 10);

  if (/\bhoje\b/.test(text)) return plusDays(0);
  if (/\bamanha\b/.test(text)) return plusDays(1);
  if (/\bdepois\s+de\s+amanha\b/.test(text)) return plusDays(2);

  const relative = text.match(/\b(?:daqui\s+a|em)\s+(\d{1,2})\s+dias?\b/);
  if (relative) return plusDays(Number(relative[1]));

  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const br = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (br) {
    const year = br[3] ? (br[3].length === 2 ? `20${br[3]}` : br[3]) : parts.year;
    const candidate = new Date(Date.UTC(Number(year), Number(br[2]) - 1, Number(br[1])));
    if (candidate.getUTCFullYear() !== Number(year) || candidate.getUTCMonth() !== Number(br[2]) - 1 || candidate.getUTCDate() !== Number(br[1])) return '';
    return candidate.toISOString().slice(0, 10);
  }

  const dayOnly = text.match(/\bdia\s+(\d{1,2})\b/);
  if (dayOnly) {
    const day = Number(dayOnly[1]);
    let candidate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, day));
    if (candidate.getUTCDate() !== day) return '';
    if (candidate < base) {
      candidate = new Date(Date.UTC(Number(parts.year), Number(parts.month), day));
      if (candidate.getUTCDate() !== day) return '';
    }
    return candidate.toISOString().slice(0, 10);
  }

  const weekdays = {
    domingo: 0, segunda: 1, 'segunda feira': 1, terca: 2, 'terca feira': 2,
    quarta: 3, 'quarta feira': 3, quinta: 4, 'quinta feira': 4,
    sexta: 5, 'sexta feira': 5, sabado: 6
  };
  for (const [label, target] of Object.entries(weekdays)) {
    if (!new RegExp(`\\b${label.replace(/ /g, '\\\\s+')}\\b`).test(text)) continue;
    const current = base.getUTCDay();
    const offset = (target - current + 7) % 7;
    return plusDays(offset);
  }
  return '';
}

function explicitTimeFromMessage(message) {
  const text = String(message || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const match = text.match(/\b(?:as\s+)?([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]?\d)?|\s+horas?)\b|\bas\s+([01]?\d|2[0-3])\b/);
  if (!match) return '';
  let hour = Number(match[1] || match[4]);
  const minute = Number(match[2] || match[3] || 0);
  const suffix = text.slice(match.index + match[0].length, match.index + match[0].length + 18);
  if (/\b(?:da\s+noite|da\s+tarde)\b/.test(suffix) && hour < 12) hour += 12;
  if (/\bda\s+manha\b/.test(suffix) && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function dueAtFromCalendarCall(call, now, timezone) {
  const args = call?.args || {};
  const rawStart = String(args.start || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(rawStart)) {
    const parsed = new Date(rawStart);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
  }
  const rawTime = args.startTime || args.time || rawStart.match(/T(\d{2}:\d{2})/)?.[1] || '';
  const clock = normalizeClock(rawTime);
  const dateIso = dateHintToIso(args.date || rawStart, now, timezone);
  if (!clock || !dateIso) return '';
  try {
    return toZonedIso(dateIso, clock, timezone);
  } catch {
    return '';
  }
}

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
  const legacyReminderCall = calls.find(call =>
    ['agendar_retorno_ou_followup', 'agendar_retorno'].includes(String(call?.name || '').trim())
  );
  const directCalendarCall = calls.find(isCalendarCreateCall);
  const candidate = reminder
    || (legacyReminderCall ? { text: legacyReminderCall.args?.reason, dueAt: legacyReminderCall.args?.when } : null)
    || (directCalendarCall ? {
      text: directCalendarCall.args?.summary,
      dueAt: dueAtFromCalendarCall(directCalendarCall, now, timezone)
    } : null);

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
  const dateParts = datePartsInTimezone(dueAt, timezone);
  const timeParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(dueAt).map(part => [part.type, part.value]));
  const actualDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const actualTime = `${timeParts.hour}:${timeParts.minute}`;
  const requestedDate = explicitDateFromMessage(message, now, timezone);
  const requestedTime = explicitTimeFromMessage(message);
  if (!requestedDate || actualDate !== requestedDate) {
    return {
      state: 'clarification',
      code: 'reminder_date_not_grounded',
      reply: requestedDate
        ? 'A data interpretada não corresponde ao dia que você informou. Confirme qual data devo usar.'
        : 'Qual é a data exata que você deseja para esse lembrete?'
      ,
      reminder: null,
      toolCalls: retainedCalls
    };
  }
  if (!requestedTime || actualTime !== requestedTime) {
    return {
      state: 'clarification',
      code: 'reminder_time_not_grounded',
      reply: requestedTime
        ? `Você informou ${requestedTime}, mas a interpretação veio como ${actualTime}. Confirme o horário correto, por favor.`
        : 'Qual horário devo usar para esse lembrete?'
      ,
      reminder: null,
      toolCalls: retainedCalls
    };
  }

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
