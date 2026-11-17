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
    weekday: map.weekday, // Sun, Mon, ...
    minutes: hour * 60 + minute,
    dateKey: `${map.year}-${map.month}-${map.day}`
  };
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

/**
 * Evaluates all prospecting safety guards in strict order before sending.
 * Fail-closed on suppression lookup failure.
 */
export async function evaluateProspectGuards({
  lead,
  list = {},
  now = new Date(),
  campaignStore = null,
  sessionStore = null,
  leadStore = null,
  config = {}
} = {}) {
  // 1. Suppression check (fail-closed)
  if (!campaignStore?.isSuppressed) {
    return { allowed: false, reason: 'suppression_unavailable' };
  }
  try {
    const suppressed = await campaignStore.isSuppressed(lead.phone);
    if (suppressed) return { allowed: false, reason: 'suppressed' };
  } catch {
    return { allowed: false, reason: 'suppression_check_failed' };
  }

  // 2. Existing client / active session check — never bypassed.
  const existingSession = sessionStore?.get?.(lead.phone);
  if (existingSession && ((existingSession.history && existingSession.history.length > 0) || existingSession.human)) {
    return { allowed: false, reason: 'existing_session' };
  }

  // 3. Business hours in configured timezone (no Sunday) — never bypassed.
  const timeZone = config.timeZone || 'America/Sao_Paulo';
  if (!isWithinBusinessWindow({ now, timeZone, windowStart: config.windowStart || '09:00', windowEnd: config.windowEnd || '18:00' })) {
    return { allowed: false, reason: 'outside_business_hours' };
  }

  // 4. Cooldown per lead (default 48h)
  const cooldownHours = config.minCooldownHours ?? 48;
  if (lead.last_contacted_at) {
    const hoursSince = (now.getTime() - new Date(lead.last_contacted_at).getTime()) / 3600000;
    if (hoursSince < cooldownHours) {
      return { allowed: false, reason: 'lead_cooldown' };
    }
  }

  // 5. Daily cap with gradual warmup.
  //    Esta checagem serve para bloquear cedo e, no dryRun, mostrar exatamente o
  //    que o envio real faria. A reserva autoritativa da vaga acontece junto do
  //    claim do lead (claimLeadWithinCap), reavaliando o cap imediatamente antes
  //    de reservar — entre estes dois passos outra réplica pode consumir a cota.
  const effectiveCap = computeWarmupDailyCap({
    baseCap: list.daily_cap ?? config.dailyCap ?? 20,
    warmupStartedAt: list.warmup_started_at,
    warmupDays: config.warmupDays ?? 21,
    now
  });
  if (leadStore?.countSentToday) {
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const sentToday = await leadStore.countSentToday({ listId: list.id || null, sinceIso: startOfDay.toISOString() });
    if (sentToday >= effectiveCap) {
      return { allowed: false, reason: 'daily_cap_reached' };
    }
  }

  return { allowed: true, effectiveCap };
}
