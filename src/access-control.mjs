import { normalizePhone } from './sessions.mjs';

const VALID_MODES = new Set(['open', 'whitelist', 'blacklist']);

function normalizeEntry(entry = '') {
  const raw = String(entry || '').trim();
  if (!raw) return '';
  if (raw.includes('@g.us')) return raw.toLowerCase();
  const digits = raw.replace(/@.*$/, '').replace(/\D/g, '');
  if (!digits) return '';
  return normalizePhone(digits) || digits;
}

function normalizeList(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  for (const item of items) {
    const clean = normalizeEntry(item);
    if (clean) seen.add(clean);
  }
  return [...seen];
}

/**
 * Normaliza as regras de controle de acesso (whitelist/blacklist/grupos).
 */
export function normalizeAccessConfig(accessControl = {}) {
  const cfg = accessControl && typeof accessControl === 'object' ? accessControl : {};
  const rawMode = String(cfg.mode || 'open').trim().toLowerCase();
  return {
    mode: VALID_MODES.has(rawMode) ? rawMode : 'open',
    whitelist: normalizeList(cfg.whitelist),
    blacklist: normalizeList(cfg.blacklist),
    ignoreGroups: cfg.ignoreGroups !== false,
    allowedGroups: normalizeList(cfg.allowedGroups)
  };
}

/**
 * Avalia se uma mensagem recebida pode ser atendida pela Lia.
 * O contato do responsável (isOwner) nunca é bloqueado.
 */
export function evaluateInboundAccess({ phone = '', jid = '', isOwner = false, accessControl = {} } = {}) {
  if (isOwner) return { allowed: true, reason: 'owner' };
  const cfg = normalizeAccessConfig(accessControl);
  const cleanJid = String(jid || '').trim().toLowerCase();
  const isGroup = cleanJid.endsWith('@g.us');
  if (isGroup) {
    if (cfg.ignoreGroups && !cfg.allowedGroups.includes(cleanJid)) {
      return { allowed: false, reason: 'group_ignored' };
    }
    if (cfg.blacklist.includes(cleanJid)) {
      return { allowed: false, reason: 'blacklisted' };
    }
    if (cfg.mode === 'whitelist' && !cfg.whitelist.includes(cleanJid) && !cfg.allowedGroups.includes(cleanJid)) {
      return { allowed: false, reason: 'not_whitelisted' };
    }
    return { allowed: true, reason: 'allowed' };
  }

  const normalizedPhone = normalizeEntry(phone || jid);
  if (!normalizedPhone) return { allowed: false, reason: 'invalid_phone' };
  if (cfg.blacklist.includes(normalizedPhone)) {
    return { allowed: false, reason: 'blacklisted' };
  }
  if (cfg.mode === 'whitelist' && !cfg.whitelist.includes(normalizedPhone)) {
    return { allowed: false, reason: 'not_whitelisted' };
  }
  return { allowed: true, reason: 'allowed' };
}
