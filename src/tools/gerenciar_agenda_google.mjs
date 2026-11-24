import crypto from 'node:crypto';
import { normalizarJanelaDeAtendimento, diasSemanaTexto } from '../business-hours.mjs';
import { readGoogleCredentials } from './google_auth.mjs';

const WEEKDAY_NAMES_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const WEEKDAY_MAP_EN = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getWeekdayInZone(dateObj, timezone = 'America/Sao_Paulo') {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(dateObj);
  const index = WEEKDAY_MAP_EN[short] ?? dateObj.getUTCDay();
  return { index, name: WEEKDAY_NAMES_PT[index] || 'dia' };
}

const MOCK_SLOTS = ['09:00', '10:30', '14:00', '15:30', '17:00'];
const GOOGLE_CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cachedOAuthToken = { token: '', expiresAt: 0 };

const integration = (botConfig = {}) => {
  const configured = botConfig?.integrations?.googleCalendar || {};
  const toolSettings = botConfig?.tools?.settings?.gerenciar_agenda_google || {};
  const credentials = readGoogleCredentials('GOOGLE_CALENDAR');
  const rawBh = botConfig?.business?.hoursConfig || botConfig?.behavior?.businessHours || botConfig?.businessHours || null;
  const shouldRestrictSchedule = Boolean(
    rawBh && (rawBh.enabled === true || rawBh.restrictScheduling === true)
  );
  const bh = shouldRestrictSchedule ? normalizarJanelaDeAtendimento({ ...rawBh, enabled: true }) : null;
  return {
    enabled: configured.enabled !== false,
    timezone: bh?.timezone || configured.timezone || 'America/Sao_Paulo',
    workdayStart: bh?.start || configured.workdayStart || '09:00',
    workdayEnd: bh?.end || configured.workdayEnd || '18:00',
    allowedWeekdays: bh ? bh.weekdays : null,
    businessHoursEnforced: Boolean(bh),
    businessHoursSummary: bh ? `${diasSemanaTexto(bh.weekdays)}, das ${bh.start} às ${bh.end}` : '',
    slotDurationMinutes: Number(configured.slotDurationMinutes) || 60,
    defaultEventDurationMinutes: Number(configured.defaultEventDurationMinutes) || 30,
    ...credentials,
    calendarId: String(toolSettings.calendarId || configured.calendarId || '').trim(),
    showMockSlotsWhenUnavailable: configured.showMockSlotsWhenUnavailable === true
  };
};

async function resolveAccessToken(settings) {
  if (settings.accessToken) return settings.accessToken;
  if (cachedOAuthToken.token && cachedOAuthToken.expiresAt > Date.now() + 60000) {
    return cachedOAuthToken.token;
  }
  if (settings.clientId && settings.clientSecret && settings.refreshToken) {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        refresh_token: settings.refreshToken,
        grant_type: 'refresh_token'
      }).toString()
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.access_token) {
        cachedOAuthToken = {
          token: data.access_token,
          expiresAt: Date.now() + (Number(data.expires_in) || 3500) * 1000
        };
        return data.access_token;
      }
    }
  }
  if (settings.serviceAccountEmail && settings.serviceAccountPrivateKey) {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claim = Buffer.from(JSON.stringify({
      iss: settings.serviceAccountEmail,
      scope: 'https://www.googleapis.com/auth/calendar',
      aud: GOOGLE_TOKEN_URL,
      exp: nowSec + 3600,
      iat: nowSec
    })).toString('base64url');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${claim}`);
    const signature = signer.sign(settings.serviceAccountPrivateKey, 'base64url');
    const assertion = `${header}.${claim}.${signature}`;
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }).toString()
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.access_token) {
        cachedOAuthToken = {
          token: data.access_token,
          expiresAt: Date.now() + (Number(data.expires_in) || 3500) * 1000
        };
        return data.access_token;
      }
    }
  }
  return '';
}

const unavailable = () => ({ success: false, error: 'google_calendar_unavailable', message: 'Integração real com Google Calendar não está configurada.' });

export function parseCalendarDate(rawDate, timezone = 'America/Sao_Paulo') {
  const s = String(rawDate || '').trim().toLowerCase();
  const now = new Date();
  if (!s || /^(?:hoje|today|agora|atual)$/i.test(s)) return now;
  if (/^(?:amanh[aã]|tomorrow)$/i.test(s)) return new Date(now.getTime() + 86400000);
  if (/^depois\s+de\s+amanh[aã]$/i.test(s)) return new Date(now.getTime() + 2 * 86400000);

  const isoDateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    const d = new Date(`${isoDateOnly[1]}-${isoDateOnly[2]}-${isoDateOnly[3]}T12:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const brDate = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (brDate) {
    const day = brDate[1].padStart(2, '0');
    const month = brDate[2].padStart(2, '0');
    const rawYear = brDate[3] ? (brDate[3].length === 2 ? `20${brDate[3]}` : brDate[3]) : String(now.getFullYear());
    const d = new Date(`${rawYear}-${month}-${day}T12:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const parsed = new Date(rawDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getIsoDateInZone(dateObj, timezone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(dateObj);
  const y = parts.find(p => p.type === 'year')?.value || '2026';
  const m = parts.find(p => p.type === 'month')?.value || '01';
  const d = parts.find(p => p.type === 'day')?.value || '01';
  return `${y}-${m}-${d}`;
}

function normalizeTimeStr(rawTime) {
  const s = String(rawTime || '').trim();
  const m = s.match(/(\d{1,2})(?::(\d{2})|h(\d{2})?)?/i);
  if (!m) return '14:00';
  const hh = String(Math.min(23, Math.max(0, Number(m[1])))).padStart(2, '0');
  const mm = String(Math.min(59, Math.max(0, Number(m[2] || m[3] || 0)))).padStart(2, '0');
  return `${hh}:${mm}`;
}

function toZonedIsoTimestamp(isoDate, timeHHMM, timezone = 'America/Sao_Paulo') {
  const probe = new Date(`${isoDate}T${timeHHMM}:00Z`);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset'
    });
    const tzPart = fmt.formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || '';
    const offsetMatch = tzPart.match(/GMT([+-]\d{2}:\d{2})/);
    const offset = offsetMatch ? offsetMatch[1] : '-03:00';
    return new Date(`${isoDate}T${timeHHMM}:00${offset}`).toISOString();
  } catch {
    return new Date(`${isoDate}T${timeHHMM}:00-03:00`).toISOString();
  }
}

async function googleRequest(endpointPath, options = {}, settings = {}) {
  const token = await resolveAccessToken(settings);
  const { apiKey, calendarId } = settings;
  const isTopLevelFreeBusy = endpointPath === '/freeBusy';
  const basePath = isTopLevelFreeBusy
    ? `${GOOGLE_CALENDAR_BASE}/freeBusy`
    : `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}${endpointPath}`;
  const sep = basePath.includes('?') ? '&' : '?';
  const query = apiKey && !token ? `${sep}key=${encodeURIComponent(apiKey)}` : '';
  const response = await fetch(`${basePath}${query}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || 'google_calendar_request_failed');
    error.status = response.status;
    throw error;
  }
  return body;
}

function parseHHMMToMinutes(hhmm = '09:00', fallback = 540) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

function formatMinutesToHHMM(totalMinutes) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.floor(totalMinutes)));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function computeSuggestedSlots({
  startDate,
  days = 3,
  durationMinutes = 30,
  stepMinutes = 30,
  workdayStart = '09:00',
  workdayEnd = '18:00',
  allowedWeekdays = null,
  timezone = 'America/Sao_Paulo',
  busyIntervals = [],
  maxSuggestions = 8,
  nowMs = Date.now()
}) {
  const startMin = parseHHMMToMinutes(workdayStart, 9 * 60);
  const endMin = parseHHMMToMinutes(workdayEnd, 18 * 60);
  const dur = Math.max(15, Math.min(240, Number(durationMinutes) || 30));
  const step = Math.max(15, Math.min(120, Number(stepMinutes) || 30));
  const busyRanges = (Array.isArray(busyIntervals) ? busyIntervals : [])
    .map(b => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter(b => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);

  const suggestions = [];
  const totalDays = Math.max(1, Math.min(14, Number(days) || 3));
  for (let offset = 0; offset < totalDays && suggestions.length < maxSuggestions; offset += 1) {
    const dayObj = new Date(startDate.getTime() + offset * 86400000);
    const weekday = getWeekdayInZone(dayObj, timezone);
    if (Array.isArray(allowedWeekdays) && allowedWeekdays.length > 0 && !allowedWeekdays.includes(weekday.index)) {
      continue;
    }
    const isoDate = getIsoDateInZone(dayObj, timezone);
    const dateLabel = dayObj.toLocaleDateString('pt-BR', { timeZone: timezone });
    for (let cursor = startMin; cursor + dur <= endMin && suggestions.length < maxSuggestions; cursor += step) {
      const timeStr = formatMinutesToHHMM(cursor);
      const slotStartMs = Date.parse(toZonedIsoTimestamp(isoDate, timeStr, timezone));
      const slotEndMs = slotStartMs + dur * 60000;
      if (slotStartMs < nowMs + 10 * 60000) continue;
      const overlaps = busyRanges.some(b => slotStartMs < b.end && slotEndMs > b.start);
      if (!overlaps) {
        suggestions.push({
          date: dateLabel,
          weekdayName: weekday.name,
          isoDate,
          startTime: timeStr,
          endTime: formatMinutesToHHMM(cursor + dur),
          durationMinutes: dur
        });
      }
    }
  }
  return suggestions;
}

export const toolGerenciarAgendaGoogle = {
  name: 'gerenciar_agenda_google',
  description: 'Gerencia a agenda do Google Calendar: consulta horários livres, sugere janelas livres em vários dias, cria reuniões/atendimentos, lista eventos ou cancela compromissos.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action: { type: 'STRING', enum: ['consultar_livres', 'sugerir_horarios', 'criar_evento', 'listar_eventos', 'cancelar_evento'] },
      date: { type: 'STRING' },
      startTime: { type: 'STRING' },
      time: { type: 'STRING' },
      days: { type: 'INTEGER', description: 'Quantos dias pesquisar em sugerir_horarios (padrão 3, máximo 14).' },
      durationMinutes: { type: 'INTEGER', description: 'Duração desejada em minutos para sugerir_horarios (padrão 30).' },
      summary: { type: 'STRING' },
      attendeeEmail: { type: 'STRING' },
      attendeePhone: { type: 'STRING' }
    },
    required: ['action']
  },
  async execute({ action, date, startTime, time: altTime, start: altStart, days, durationMinutes, summary, attendeeEmail, attendeePhone }, context = {}) {
    if (context.actor === 'client' && !['consultar_livres', 'sugerir_horarios', 'criar_evento'].includes(action)) {
      return { success: false, error: 'forbidden_for_client', message: 'A consulta de eventos internos e o cancelamento da agenda são operações restritas ao responsável.' };
    }
    if (!['consultar_livres', 'sugerir_horarios', 'criar_evento', 'listar_eventos', 'cancelar_evento'].includes(action)) {
      return { success: false, error: 'invalid_action', message: 'Ação de agenda inválida.' };
    }
    const settings = integration(context.botConfig);
    if (!settings.enabled) {
      return { success: false, error: 'google_calendar_disabled', message: 'A integração com o Google Calendar está desativada no painel.' };
    }
    const targetDate = parseCalendarDate(date || altStart, settings.timezone);
    if (!targetDate) return { success: false, error: 'invalid_date', message: 'Data inválida para a agenda.' };
    const dateFormatted = targetDate.toLocaleDateString('pt-BR', { timeZone: settings.timezone });
    const weekday = getWeekdayInZone(targetDate, settings.timezone);
    const isoDate = getIsoDateInZone(targetDate, settings.timezone);
    const chosenTime = normalizeTimeStr(startTime || altTime || (altStart && String(altStart).includes('T') ? String(altStart).split('T')[1] : '') || '14:00');
    const isClosedDay = Boolean(
      settings.businessHoursEnforced
      && Array.isArray(settings.allowedWeekdays)
      && !settings.allowedWeekdays.includes(weekday.index)
    );
    const chosenMinutes = parseHHMMToMinutes(chosenTime, 14 * 60);
    const workStartMinutes = parseHHMMToMinutes(settings.workdayStart, 9 * 60);
    const workEndMinutes = parseHHMMToMinutes(settings.workdayEnd, 18 * 60);
    const isOutsideWorkHours = Boolean(
      settings.businessHoursEnforced
      && (chosenMinutes < workStartMinutes || chosenMinutes + settings.defaultEventDurationMinutes > workEndMinutes)
    );

    if (action === 'consultar_livres' && isClosedDay) {
      return {
        success: true,
        closedDay: true,
        date: dateFormatted,
        weekdayName: weekday.name,
        availableSlots: [],
        message: `Não há atendimento em ${weekday.name} (${dateFormatted}). Nosso expediente é de ${settings.businessHoursSummary}.`
      };
    }
    if (action === 'criar_evento' && (isClosedDay || isOutsideWorkHours)) {
      return {
        success: false,
        error: 'outside_business_hours',
        closedDay: isClosedDay,
        date: dateFormatted,
        weekdayName: weekday.name,
        time: chosenTime,
        message: isClosedDay
          ? `Não é possível agendar em ${weekday.name} (${dateFormatted}) porque estamos fora do expediente (${settings.businessHoursSummary}).`
          : `Não é possível agendar em ${weekday.name} (${dateFormatted}) às ${chosenTime} — nosso expediente é de ${settings.businessHoursSummary}.`
      };
    }

    if (settings.showMockSlotsWhenUnavailable) {
      if (action === 'consultar_livres') return { success: true, mocked: true, date: dateFormatted, availableSlots: MOCK_SLOTS, message: `Para a data ${dateFormatted}, os horários disponíveis na agenda são: ${MOCK_SLOTS.join(', ')}.` };
      if (action === 'sugerir_horarios') {
        const dur = Number(durationMinutes) || settings.defaultEventDurationMinutes;
        const suggested = MOCK_SLOTS.slice(0, 4).map(slot => ({ date: dateFormatted, isoDate, startTime: slot, endTime: formatMinutesToHHMM(parseHHMMToMinutes(slot) + dur), durationMinutes: dur }));
        return { success: true, mocked: true, date: dateFormatted, suggestions: suggested, availableSlots: MOCK_SLOTS.slice(0, 4), message: `Sugestões de horários livres a partir de ${dateFormatted}: ${suggested.map(s => `${s.date} às ${s.startTime}`).join(', ')}.` };
      }
      if (action === 'criar_evento') return { success: true, mocked: true, event: { title: summary || `Atendimento com ${context.clientName || 'Cliente'}`, date: dateFormatted, time: chosenTime, status: 'confirmed' }, message: `Compromisso simulado com sucesso para ${dateFormatted} às ${chosenTime}.` };
    }

    const hasCredentials = Boolean(
      settings.accessToken ||
      settings.apiKey ||
      (settings.clientId && settings.clientSecret && settings.refreshToken) ||
      (settings.serviceAccountEmail && settings.serviceAccountPrivateKey)
    );
    if (!hasCredentials) return unavailable();

    try {
      if (action === 'sugerir_horarios') {
        const totalDays = Math.max(1, Math.min(14, Number(days) || 3));
        const dur = Math.max(15, Math.min(240, Number(durationMinutes) || settings.defaultEventDurationMinutes));
        const endDateObj = new Date(targetDate.getTime() + (totalDays - 1) * 86400000);
        const endIsoDate = getIsoDateInZone(endDateObj, settings.timezone);
        const rangeStartIso = toZonedIsoTimestamp(isoDate, '00:00', settings.timezone);
        const rangeEndIso = toZonedIsoTimestamp(endIsoDate, '23:59', settings.timezone);
        const body = await googleRequest('/freeBusy', {
          method: 'POST',
          body: JSON.stringify({
            timeMin: rangeStartIso,
            timeMax: rangeEndIso,
            timeZone: settings.timezone,
            items: [{ id: settings.calendarId }]
          })
        }, settings);
        const busy = body.calendars?.[settings.calendarId]?.busy || [];
        const suggestions = computeSuggestedSlots({
          startDate: targetDate,
          days: totalDays,
          durationMinutes: dur,
          stepMinutes: settings.slotDurationMinutes || 30,
          workdayStart: settings.workdayStart,
          workdayEnd: settings.workdayEnd,
          allowedWeekdays: settings.allowedWeekdays,
          timezone: settings.timezone,
          busyIntervals: busy,
          maxSuggestions: 8
        });
        return {
          success: true,
          date: dateFormatted,
          weekdayName: weekday.name,
          daysChecked: totalDays,
          durationMinutes: dur,
          suggestions,
          availableSlots: suggestions.map(s => `${s.weekdayName} (${s.date}) às ${s.startTime}`),
          message: suggestions.length
            ? `Sugestões de horários livres (${dur} min): ${suggestions.map(s => `${s.weekdayName}, ${s.date} às ${s.startTime}`).join(', ')}.`
            : `Não encontrei janelas livres de ${dur} min nos próximos ${totalDays} dia(s) a partir de ${weekday.name} (${dateFormatted}).`
        };
      }
      if (action === 'consultar_livres') {
        const dayStartIso = toZonedIsoTimestamp(isoDate, '00:00', settings.timezone);
        const dayEndIso = toZonedIsoTimestamp(isoDate, '23:59', settings.timezone);
        const body = await googleRequest('/freeBusy', {
          method: 'POST',
          body: JSON.stringify({
            timeMin: dayStartIso,
            timeMax: dayEndIso,
            timeZone: settings.timezone,
            items: [{ id: settings.calendarId }]
          })
        }, settings);
        const busy = body.calendars?.[settings.calendarId]?.busy || [];
        const availableSlots = MOCK_SLOTS.filter(slot => {
          const slotStartMs = new Date(toZonedIsoTimestamp(isoDate, slot, settings.timezone)).getTime();
          const slotEndMs = slotStartMs + settings.defaultEventDurationMinutes * 60000;
          return !busy.some(item => {
            const bStart = new Date(item.start).getTime();
            const bEnd = new Date(item.end).getTime();
            if (Number.isNaN(bStart) || Number.isNaN(bEnd)) {
              return String(item.start).includes(`T${slot}:`);
            }
            return slotStartMs < bEnd && slotEndMs > bStart;
          });
        });
        return {
          success: true,
          date: dateFormatted,
          availableSlots,
          message: availableSlots.length
            ? `Para ${dateFormatted}, os horários livres são: ${availableSlots.join(', ')}.`
            : `Não há horários livres disponíveis em ${dateFormatted}.`
        };
      }
      if (action === 'criar_evento') {
        const token = await resolveAccessToken(settings);
        if (!token) return { success: false, error: 'google_calendar_write_unavailable', message: 'Token OAuth ou Service Account é necessário para criar eventos no Google Calendar.' };
        const start = toZonedIsoTimestamp(isoDate, chosenTime, settings.timezone);
        const end = new Date(new Date(start).getTime() + settings.defaultEventDurationMinutes * 60000).toISOString();
        const event = await googleRequest('/events', {
          method: 'POST',
          body: JSON.stringify({
            summary: summary || `Atendimento com ${context.clientName || 'Cliente'}`,
            start: { dateTime: start, timeZone: settings.timezone },
            end: { dateTime: end, timeZone: settings.timezone },
            attendees: attendeeEmail ? [{ email: attendeeEmail }] : undefined,
            description: attendeePhone ? `Telefone: ${attendeePhone}` : undefined
          })
        }, settings);
        return {
          success: true,
          event: { id: event.id, title: event.summary, date: dateFormatted, time: chosenTime, status: event.status || 'confirmed' },
          message: `Compromisso agendado com sucesso para ${dateFormatted} às ${chosenTime}.`
        };
      }
      if (action === 'listar_eventos') {
        const dayStartIso = toZonedIsoTimestamp(isoDate, '00:00', settings.timezone);
        const body = await googleRequest(`/events?timeMin=${encodeURIComponent(dayStartIso)}&singleEvents=true&orderBy=startTime`, {}, settings);
        return { success: true, date: dateFormatted, events: body.items || [] };
      }
      return { success: false, error: 'unsupported_action', message: 'Cancelamento requer o identificador do evento.' };
    } catch (error) {
      return { success: false, error: 'google_calendar_error', message: 'Não foi possível consultar o Google Calendar.', status: error.status };
    }
  }
};
