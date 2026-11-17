function parseClockMinutes(hhmm = '09:00') {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

export function getLocalClock(now = new Date(), timeZone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const hour = Number(map.hour === '24' ? 0 : map.hour);
  const minute = Number(map.minute);
  return {
    weekday: map.weekday,
    minutes: hour * 60 + minute,
    dateKey: `${map.year}-${map.month}-${map.day}`
  };
}

/** Retorna o instante UTC correspondente à meia-noite do dia local. */
export function localDayStartIso(now = new Date(), timeZone = 'America/Sao_Paulo') {
  const { dateKey } = getLocalClock(now, timeZone);
  const [year, month, day] = dateKey.split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(guess));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const shown = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour === '24' ? 0 : map.hour), Number(map.minute), Number(map.second));
  return new Date(guess - (shown - guess)).toISOString();
}

export function isWithinBusinessWindow({ now = new Date(), timeZone = 'America/Sao_Paulo', windowStart = '09:00', windowEnd = '18:00' } = {}) {
  const local = getLocalClock(now, timeZone);
  if (local.weekday === 'Sun') return false;
  const start = parseClockMinutes(windowStart) ?? 9 * 60;
  const end = parseClockMinutes(windowEnd) ?? 18 * 60;
  return local.minutes >= start && local.minutes <= end;
}

export function computeWarmupDailyCap({ baseCap = 20, warmupStartedAt = null, warmupDays = 21, now = new Date() } = {}) {
  const cap = Math.max(1, Number(baseCap) || 20);
  if (!warmupStartedAt || !warmupDays || warmupDays <= 0) return cap;
  const elapsedDays = Math.max(0, Math.floor((now.getTime() - new Date(warmupStartedAt).getTime()) / 86400000));
  if (elapsedDays >= warmupDays) return cap;
  const ratio = Math.max(0.25, (elapsedDays + 1) / warmupDays);
  return Math.max(1, Math.round(cap * ratio));
}

/** Avalia guards sem criar uma sessão vazia para cada lead. */
export async function evaluateProspectGuards({
  lead,
  list = {},
  now = new Date(),
  campaignStore = null,
  sessionStore = null,
  leadStore = null,
  config = {}
} = {}) {
  if (!campaignStore?.isSuppressed) return { allowed: false, reason: 'suppression_unavailable' };
  try {
    if (await campaignStore.isSuppressed(lead.phone)) return { allowed: false, reason: 'suppressed' };
  } catch {
    return { allowed: false, reason: 'suppression_check_failed' };
  }

  try {
    const hasSession = typeof sessionStore?.has === 'function' ? sessionStore.has(lead.phone) : false;
    const existingSession = hasSession && sessionStore.get(lead.phone);
    if (existingSession && ((existingSession.history?.length || 0) > 0 || existingSession.human)) {
      return { allowed: false, reason: 'existing_session' };
    }
  } catch {
    return { allowed: false, reason: 'session_check_failed' };
  }

  const timeZone = config.timeZone || 'America/Sao_Paulo';
  if (!isWithinBusinessWindow({ now, timeZone, windowStart: config.windowStart || '09:00', windowEnd: config.windowEnd || '18:00' })) {
    return { allowed: false, reason: 'outside_business_hours' };
  }

  const cooldownHours = config.minCooldownHours ?? 48;
  if (lead.last_contacted_at) {
    const hoursSince = (now.getTime() - new Date(lead.last_contacted_at).getTime()) / 3600000;
    if (hoursSince < cooldownHours) return { allowed: false, reason: 'lead_cooldown' };
  }

  const effectiveCap = computeWarmupDailyCap({
    baseCap: list.daily_cap ?? config.dailyCap ?? 20,
    warmupStartedAt: list.warmup_started_at,
    warmupDays: config.warmupDays ?? 21,
    now
  });
  if (leadStore?.countSentToday) {
    const sentToday = await leadStore.countSentToday({
      listId: list.id || null,
      sinceIso: localDayStartIso(now, timeZone),
      timeZone
    });
    if (sentToday >= effectiveCap) return { allowed: false, reason: 'daily_cap_reached' };
  }
  return { allowed: true, effectiveCap };
}
