const HANDOFF_SNAPSHOT_FIELDS = Object.freeze([
  'human',
  'humanSource',
  'handoffAt',
  'handoffReason',
  'handoffUrgency',
  'handoffNotified',
  'handoffNotifyFailed',
  'handoffReminderAt',
  'handoffReminder1Sent',
  'handoffReminder60Sent',
  'updatedAt'
]);

function assertSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new TypeError('A sessão do atendimento humano precisa ser um objeto.');
  }
}

function normalizeHandoffTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return String(value);
}

/**
 * Compatibilidade com sessões persistidas: o booleano legado `human`
 * continua sendo a fonte de verdade até uma futura migração explícita.
 */
export function isHumanHandoffActive(session) {
  return Boolean(session?.human);
}

export function getHumanHandoffState(session) {
  return isHumanHandoffActive(session) ? 'human' : 'bot';
}

/**
 * Ativa o atendimento humano e atualiza apenas os metadados fornecidos.
 * `preserveSource` mantém a origem existente; `onlyIfInactive` evita
 * sobrescrever o primeiro handoff quando a sessão já está sob atendimento.
 */
export function enterHumanHandoff(session, {
  source,
  at,
  reason,
  urgency,
  preserveSource = false,
  onlyIfInactive = false
} = {}) {
  assertSession(session);
  const wasAlreadyHuman = isHumanHandoffActive(session);
  if (onlyIfInactive && wasAlreadyHuman) {
    return { changed: false, wasAlreadyHuman: true };
  }

  session.human = true;
  if (source !== undefined && (!preserveSource || !session.humanSource)) {
    session.humanSource = source;
  }
  if (at !== undefined && at !== null) {
    session.handoffAt = normalizeHandoffTimestamp(at);
  }
  if (reason !== undefined) session.handoffReason = reason;
  if (urgency !== undefined) session.handoffUrgency = urgency;

  return { changed: !wasAlreadyHuman, wasAlreadyHuman };
}

/**
 * Retoma o bot sem apagar metadados por padrão. Cada família de campos só é
 * limpa quando a transição antiga já fazia essa limpeza explicitamente.
 */
export function resumeHumanHandoff(session, {
  source,
  clearHandoffAt = false,
  clearHandoffReason = false,
  clearHandoffUrgency = false,
  clearReminderAt = false,
  clearNotifications = false,
  clearNotifyFailed = false,
  clearReminderFlags = false
} = {}) {
  assertSession(session);
  session.human = false;
  if (source !== undefined) session.humanSource = source;
  if (clearHandoffAt) session.handoffAt = null;
  if (clearHandoffReason) session.handoffReason = null;
  if (clearHandoffUrgency) session.handoffUrgency = null;
  if (clearReminderAt) session.handoffReminderAt = null;
  if (clearNotifications) session.handoffNotified = false;
  if (clearNotifyFailed) session.handoffNotifyFailed = false;
  if (clearReminderFlags) {
    session.handoffReminder1Sent = false;
    session.handoffReminder60Sent = false;
  }
  return session;
}

export function captureHumanHandoffSnapshot(session, fields = HANDOFF_SNAPSHOT_FIELDS) {
  assertSession(session);
  return Object.fromEntries(fields.map(field => [field, session[field]]));
}

export function restoreHumanHandoffSnapshot(session, snapshot = {}) {
  assertSession(session);
  for (const [field, value] of Object.entries(snapshot || {})) {
    session[field] = value;
  }
  return session;
}

export { HANDOFF_SNAPSHOT_FIELDS };
