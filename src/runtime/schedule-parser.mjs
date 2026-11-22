const WEEKDAYS_PT = Object.freeze({
  domingo: 0,
  segunda: 1, 'segunda-feira': 1,
  terca: 2, 'terça': 2, 'terca-feira': 2, 'terça-feira': 2,
  quarta: 3, 'quarta-feira': 3,
  quinta: 4, 'quinta-feira': 4,
  sexta: 5, 'sexta-feira': 5,
  sabado: 6, 'sábado': 6
});

function getZonedParts(ms, timezone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false
  }).formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === '24' ? 0 : map.hour),
    minute: Number(map.minute),
    weekday: weekdayMap[map.weekday] ?? 0
  };
}

function getZoneOffsetStr(isoDate, timeHHMM, timezone = 'America/Sao_Paulo') {
  try {
    const probe = new Date(`${isoDate}T${timeHHMM}:00Z`);
    const tzPart = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset'
    }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || '';
    const m = tzPart.match(/GMT([+-]\d{2}:\d{2})/);
    if (m) return m[1];
  } catch {}
  return '-03:00';
}

function buildZonedIso(year, month, day, hour, minute, timezone = 'America/Sao_Paulo') {
  const isoDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const offset = getZoneOffsetStr(isoDate, hhmm, timezone);
  return new Date(`${isoDate}T${hhmm}:00${offset}`).toISOString();
}

function addDaysZoned(baseMs, days, hour, minute, timezone = 'America/Sao_Paulo') {
  const target = new Date(baseMs + days * 86_400_000);
  const p = getZonedParts(target.getTime(), timezone);
  return buildZonedIso(p.year, p.month, p.day, hour, minute, timezone);
}

export function computeNextRecurrenceIso(recurrence, fromMs = Date.now(), timezone = 'America/Sao_Paulo') {
  if (!recurrence || typeof recurrence !== 'object') return null;
  if (recurrence.kind === 'interval_minutes') {
    const mins = Math.max(1, Math.min(43200, Number(recurrence.intervalMinutes) || 60));
    return new Date(fromMs + mins * 60_000).toISOString();
  }
  const hour = Math.max(0, Math.min(23, Number(recurrence.hour ?? 9)));
  const minute = Math.max(0, Math.min(59, Number(recurrence.minute ?? 0)));

  if (recurrence.kind === 'daily') {
    const todayIso = addDaysZoned(fromMs, 0, hour, minute, timezone);
    if (Date.parse(todayIso) > fromMs + 30_000) return todayIso;
    return addDaysZoned(fromMs, 1, hour, minute, timezone);
  }

  if (recurrence.kind === 'weekly') {
    const targetDay = Math.max(0, Math.min(6, Number(recurrence.weekday ?? 1)));
    const nowParts = getZonedParts(fromMs, timezone);
    let delta = (targetDay - nowParts.weekday + 7) % 7;
    let candidate = addDaysZoned(fromMs, delta, hour, minute, timezone);
    if (Date.parse(candidate) <= fromMs + 30_000) {
      candidate = addDaysZoned(fromMs, delta + 7, hour, minute, timezone);
    }
    return candidate;
  }

  return null;
}

function inferAutonomousAction(cleanText = '') {
  if (/\b(?:sa[uú]de|apis?|infra(?:estrutura)?|event\s*loop|servi[cç]os?|servidor|vps|baileys|whatsapp|sistema)\b/i.test(cleanText)) {
    return {
      actionTool: 'consultar_saude_infra',
      actionArgs: { target: 'geral' },
      titulo: 'Verificação autônoma de saúde da infraestrutura e APIs',
      assunto: 'infraestrutura'
    };
  }
  if (/\b(?:gmail|e-?mails?|caixa\s+de\s+entrada|mensagens?\s+n[aã]o\s+lid[ao]s?)\b/i.test(cleanText)) {
    return {
      actionTool: 'gerenciar_gmail_google',
      actionArgs: { acao: 'buscar_mensagens', busca: 'is:unread', limite: 8 },
      titulo: 'Resumo automático de e-mails não lidos no Gmail',
      assunto: 'gmail'
    };
  }
  if (/\b(?:minha\s+agenda|agenda\s+de\s+hoje|agenda\s+do\s+dia|compromissos?\s+do\s+dia|eventos?\s+de\s+hoje)\b/i.test(cleanText)) {
    return {
      actionTool: 'gerenciar_agenda_google',
      actionArgs: { action: 'listar_eventos', date: 'hoje' },
      titulo: 'Resumo automático da agenda do dia',
      assunto: 'agenda'
    };
  }
  if (/\b(?:planilha|google\s+sheets|sheets)\b/i.test(cleanText)) {
    return {
      actionTool: 'consultar_planilha_google',
      actionArgs: { acao: 'ler_intervalo' },
      titulo: 'Consulta automática de planilha Google Sheets',
      assunto: 'planilha'
    };
  }
  const webMatch = cleanText.match(/\b(?:pesquis\w*|busc\w*)\s+(?:na\s+web\s+|no\s+google\s+|not[ií]cias?\s+)?(?:sobre\s+)?(.{4,120})/i);
  if (webMatch && /\b(?:web|google|not[ií]cias?|internet|pre[cç]o|cota[cç][aã]o)\b/i.test(cleanText)) {
    const query = webMatch[1].replace(/\b(?:e\s+me\s+avis\w*|e\s+me\s+mand\w*|para\s+daqui.*|todo\s+dia.*|amanh[aã].*|hoje\s+[aà]s.*)$/i, '').trim();
    if (query.length >= 3) {
      return {
        actionTool: 'consultar_web',
        actionArgs: { query: query.slice(0, 140) },
        titulo: `Pesquisa web automática: ${query.slice(0, 100)}`,
        assunto: 'web'
      };
    }
  }
  return {
    actionTool: null,
    actionArgs: {},
    titulo: cleanText.replace(/\s+/g, ' ').trim().slice(0, 140),
    assunto: 'owner'
  };
}

export function parseAutonomousCommand(rawText = '', { nowMs = Date.now(), timezone = 'America/Sao_Paulo' } = {}) {
  const clean = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;

  // 1) Listar tarefas/rotinas agendadas
  if (/^(?:quais|listar?|mostr\w*|ver|minhas?)\s+(?:as\s+|os\s+|meus\s+|minhas\s+)?(?:tarefas?\s+agendad[ao]s?|rotinas?|agendamentos?\s+aut[oô]nomos?|compromissos?\s+(?:agendados?|pendentes?|aut[oô]nomos?)|verifica[cç][oõ]es?\s+agendad[ao]s?)\??$/i.test(clean)
    || /\b(?:quais\s+(?:tarefas?|rotinas?|compromissos?|verifica[cç][oõ]es?)\s+(?:est[aã]o\s+)?(?:agendad[ao]s?|pendentes?)|minhas?\s+rotinas?\s+agendad[ao]s?)\b/i.test(clean)) {
    return { kind: 'list' };
  }

  // 2) Cancelar compromisso/rotina por #ID
  const cancelMatch = clean.match(/\b(?:cancel\w*|remov\w*|apag\w*|par\w*|desativ\w*)\s+(?:a\s+|o\s+)?(?:rotina|tarefa|agendamento|compromisso|verifica[cç][aã]o)\s+#?([0-9a-f-]{6,36})\b/i)
    || clean.match(/\b(?:cancel\w*|remov\w*)\s+#([0-9a-f-]{6,36})\b/i);
  if (cancelMatch) {
    return { kind: 'cancel', targetId: cancelMatch[1].toLowerCase() };
  }

  // Não sequestrar envios para clientes externos nem criação de reunião com cliente
  const isExternalClientSend = /\b(?:envi\w*|mand\w*|dispar\w*|fal\w*)\b.{0,25}\b(?:para\s+o|para\s+a|pro|pra|ao|à|com\s+o|com\s+a)\s+[A-ZÀ-Ú]/i.test(clean);
  const isCalendarMeeting = /\b(?:reuni[aã]o|google\s+calendar|evento\s+na\s+agenda|consulta\s+com|marcar\s+com)\b/i.test(clean);
  if (isExternalClientSend || isCalendarMeeting) return null;

  const hasScheduleVerb = /\b(?:agend\w*|program\w*|verific\w*|chec\w*|resum\w*|consult\w*|pesquis\w*|me\s+avis\w*|me\s+lembr\w*|lembre-?me|me\s+mand\w*)\b/i.test(clean);
  if (!hasScheduleVerb) return null;

  const action = inferAutonomousAction(clean);

  // 3A) Rotina recorrente por intervalo: "a cada 2 horas" / "a cada 30 minutos"
  const everyInterval = clean.match(/\ba\s+cada\s+(\d{1,3})\s*(min(?:uto)?s?|h(?:ora)?s?)\b/i);
  if (everyInterval) {
    const qty = Number(everyInterval[1]);
    const isHours = /^h/i.test(everyInterval[2]);
    const intervalMinutes = Math.max(5, Math.min(43200, isHours ? qty * 60 : qty));
    const recurrence = { kind: 'interval_minutes', intervalMinutes };
    const dueAt = computeNextRecurrenceIso(recurrence, nowMs, timezone);
    return {
      kind: 'schedule',
      dueAt,
      inMinutes: intervalMinutes,
      recurrence,
      recurrenceLabel: isHours ? `a cada ${qty}h` : `a cada ${intervalMinutes} min`,
      ...action
    };
  }

  // 3B) Rotina recorrente diária: "todo dia às 8h" / "diariamente às 09:30"
  const dailyMatch = clean.match(/\b(?:todo\s+dia|todos\s+os\s+dias|diariamente)\b.{0,20}?\b(?:[aà]s\s+)?(\d{1,2})(?::(\d{2})|h(\d{2})?)?\b/i);
  if (dailyMatch) {
    const hour = Math.min(23, Math.max(0, Number(dailyMatch[1])));
    const minute = Math.min(59, Math.max(0, Number(dailyMatch[2] || dailyMatch[3] || 0)));
    const recurrence = { kind: 'daily', hour, minute };
    const dueAt = computeNextRecurrenceIso(recurrence, nowMs, timezone);
    const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return {
      kind: 'schedule',
      dueAt,
      recurrence,
      recurrenceLabel: `todo dia às ${hhmm}`,
      ...action
    };
  }

  // 3C) Rotina recorrente semanal: "toda segunda às 9h" / "toda sexta-feira às 17:30"
  const weeklyMatch = clean.match(/\b(?:tod[oa]\s+)(domingo|segunda(?:-feira)?|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado)\b.{0,20}?\b(?:[aà]s\s+)?(\d{1,2})(?::(\d{2})|h(\d{2})?)?\b/i);
  if (weeklyMatch) {
    const dayKey = weeklyMatch[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const weekday = WEEKDAYS_PT[dayKey] ?? WEEKDAYS_PT[weeklyMatch[1].toLowerCase()] ?? 1;
    const hour = Math.min(23, Math.max(0, Number(weeklyMatch[2])));
    const minute = Math.min(59, Math.max(0, Number(weeklyMatch[3] || weeklyMatch[4] || 0)));
    const recurrence = { kind: 'weekly', weekday, hour, minute };
    const dueAt = computeNextRecurrenceIso(recurrence, nowMs, timezone);
    const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return {
      kind: 'schedule',
      dueAt,
      recurrence,
      recurrenceLabel: `toda ${weeklyMatch[1]} às ${hhmm}`,
      ...action
    };
  }

  // 3D) Tempo relativo: "daqui a 2 minutos" / "em 1 hora"
  const relMatch = clean.match(/(?:daqui\s+a|em|dentro\s+de)\s+(\d{1,4})\s*(min(?:uto)?s?|h(?:ora)?s?)\b/i);
  if (relMatch) {
    const qty = Number(relMatch[1]);
    const isHours = /^h/i.test(relMatch[2]);
    const inMinutes = Math.max(1, Math.min(43200, isHours ? qty * 60 : qty));
    const dueAt = new Date(nowMs + inMinutes * 60_000).toISOString();
    return {
      kind: 'schedule',
      dueAt,
      inMinutes,
      recurrence: null,
      recurrenceLabel: null,
      ...action
    };
  }

  // 3E) Horário fixo: "amanhã às 9h" / "hoje às 15:30" / "às 14h"
  const fixedMatch = clean.match(/\b(amanh[aã]|hoje)?\s*[aà]s\s+(\d{1,2})(?::(\d{2})|h(\d{2})?)?\b/i);
  if (fixedMatch) {
    const isTomorrow = Boolean(fixedMatch[1] && /^amanh/i.test(fixedMatch[1]));
    const hour = Math.min(23, Math.max(0, Number(fixedMatch[2])));
    const minute = Math.min(59, Math.max(0, Number(fixedMatch[3] || fixedMatch[4] || 0)));
    let dueAt = addDaysZoned(nowMs, isTomorrow ? 1 : 0, hour, minute, timezone);
    if (!isTomorrow && Date.parse(dueAt) <= nowMs + 30_000) {
      dueAt = addDaysZoned(nowMs, 1, hour, minute, timezone);
    }
    return {
      kind: 'schedule',
      dueAt,
      recurrence: null,
      recurrenceLabel: null,
      ...action
    };
  }

  return null;
}
