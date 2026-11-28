import crypto from 'node:crypto';

const ACTIVE_SLA_STAGES = new Set(['novo', 'em_atendimento', 'negociacao']);
const MAX_ACTIVITIES = 80;
const MAX_INTERNAL_NOTES = 50;

/**
 * Registra um evento na timeline unificada do lead (session.activities).
 */
export function appendActivity(session, { type = 'crm_update', title = '', detail = '', actor = 'system', at = new Date().toISOString() } = {}) {
  if (!session || typeof session !== 'object') return null;
  if (!Array.isArray(session.activities)) session.activities = [];
  const entry = {
    id: crypto.randomUUID(),
    type: String(type || 'crm_update').trim().slice(0, 40),
    title: String(title || '').trim().slice(0, 120),
    detail: String(detail || '').trim().slice(0, 400),
    actor: String(actor || 'system').trim().slice(0, 60),
    at: String(at || new Date().toISOString())
  };
  if (!entry.title) return null;
  session.activities.unshift(entry);
  if (session.activities.length > MAX_ACTIVITIES) {
    session.activities = session.activities.slice(0, MAX_ACTIVITIES);
  }
  return entry;
}

/**
 * Adiciona uma nota interna privada (nunca enviada ao WhatsApp) e registra na timeline.
 */
export function addInternalNote(session, { text = '', author = 'Equipe', at = new Date().toISOString() } = {}) {
  const cleanText = String(text || '').trim().slice(0, 1000);
  if (!session || !cleanText) return null;
  if (!Array.isArray(session.internalNotes)) session.internalNotes = [];
  const note = {
    id: crypto.randomUUID(),
    text: cleanText,
    author: String(author || 'Equipe').trim().slice(0, 60),
    at: String(at || new Date().toISOString())
  };
  session.internalNotes.unshift(note);
  if (session.internalNotes.length > MAX_INTERNAL_NOTES) {
    session.internalNotes = session.internalNotes.slice(0, MAX_INTERNAL_NOTES);
  }
  appendActivity(session, {
    type: 'internal_note',
    title: 'Nota interna adicionada',
    detail: cleanText,
    actor: note.author,
    at: note.at
  });
  return note;
}

/**
 * Calcula o status de SLA do lead com base no estágio atual e último contato.
 */
export function computeLeadSlaStatus(session, { slaHours = 24, nowMs = Date.now() } = {}) {
  const limitHours = Math.max(1, Math.min(720, Number(slaHours) || 24));
  const stage = String(session?.funnelStage || 'novo').trim().toLowerCase();
  if (!ACTIVE_SLA_STAGES.has(stage)) {
    return { active: false, overdue: false, idleHours: 0, slaHours: limitHours };
  }
  const refMs = Date.parse(session?.updatedAt || session?.lastUserMessageAt || session?.createdAt || '');
  if (!Number.isFinite(refMs)) {
    return { active: true, overdue: false, idleHours: 0, slaHours: limitHours };
  }
  const idleHours = Math.max(0, Math.floor(((nowMs - refMs) / 3_600_000) * 10) / 10);
  return {
    active: true,
    overdue: idleHours >= limitHours,
    idleHours,
    slaHours: limitHours
  };
}

/**
 * Sanitiza campos customizáveis do perfil do lead.
 */
export function normalizeCustomFields(rawFields = {}) {
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) return {};
  const clean = {};
  for (const [rawKey, rawVal] of Object.entries(rawFields).slice(0, 30)) {
    const key = String(rawKey || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40);
    if (!key) continue;
    if (rawVal === null || rawVal === undefined || rawVal === '') continue;
    clean[key] = String(rawVal).trim().slice(0, 240);
  }
  return clean;
}

/**
 * Renderiza variáveis de respostas rápidas / macros.
 */
export function renderQuickReplyTemplate(template = '', { name = '', company = '' } = {}) {
  return String(template || '')
    .replace(/\{\{\s*(?:nome|name)\s*\}\}/gi, String(name || 'cliente').trim() || 'cliente')
    .replace(/\{\{\s*(?:empresa|company)\s*\}\}/gi, String(company || '').trim());
}
