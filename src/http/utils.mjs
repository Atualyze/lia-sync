import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.mjs';
import { isOwnerKey } from '../core/identity.mjs';
import { formatPhoneNumber as formatPhoneNumberCanonical } from '../sessions.mjs';

// Sentinela usada pelos handlers de rota: qualquer branch que atende a request
// retorna algo (frequentemente `undefined`); só o fallback sem match retorna isto.
export const NOT_HANDLED = Symbol('not_handled');

const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export function withoutHopByHopHeaders(headers = {}) {
  const result = { ...headers };
  const blocked = new Set(HOP_BY_HOP_HEADERS);
  for (const token of String(result.connection || '').split(',')) {
    if (token.trim()) blocked.add(token.trim().toLowerCase());
  }
  for (const name of blocked) delete result[name];
  delete result.host;
  return result;
}

export function json(res, status, body, origin = '') { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(origin ? { 'access-control-allow-origin': origin } : {}) }); res.end(JSON.stringify(body)); }

export function authorized(req, token = config.webhookToken) { if (!token) return config.allowInsecureWebhook; const a = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')); const b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); }
export async function readBody(req, max = 256 * 1024) { let size = 0; const parts = []; for await (const chunk of req) { size += chunk.length; if (size > max) { const e = Error('payload too large'); e.statusCode = 413; throw e; } parts.push(chunk); } try { return JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { const e = Error('invalid json'); e.statusCode = 400; throw e; } }
export const formatPhoneNumber = formatPhoneNumberCanonical;
export function formatActivityTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  const timeZone = config.businessTimeZone || 'America/Sao_Paulo';
  const parts = value => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(value).map(p => [p.type, p.value]));
  const target = parts(d);
  const current = parts(new Date());
  const targetKey = `${target.year}-${target.month}-${target.day}`;
  const currentKey = `${current.year}-${current.month}-${current.day}`;
  const yesterday = new Date(Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day) - 1));
  const yesterdayParts = parts(yesterday);
  const timeStr = `${target.hour === '24' ? '00' : target.hour}:${target.minute}`;
  if (targetKey === currentKey) return timeStr;
  if (targetKey === `${yesterdayParts.year}-${yesterdayParts.month}-${yesterdayParts.day}`) return `Ontem ${timeStr}`;
  return `${target.day}/${target.month} ${timeStr}`;
}
export function deliveryTarget(job, defaultPhone = '') {
  if (isOwnerKey(job?.phone) || isOwnerKey(job?.jid)) {
    const rawJid = String(job?.jid || '');
    if (rawJid && !isOwnerKey(rawJid) && !/@lid$/i.test(rawJid)) return rawJid;
    return defaultPhone || rawJid;
  }
  const jid = String(job?.jid || '');
  const phone = String(job?.phone || '');
  if (/@lid$/i.test(jid)) {
    const cleanDigits = phone.replace(/\D/g, '');
    const isRealPhone = !/@lid$/i.test(phone) && cleanDigits.length >= 10 && cleanDigits.length <= 13;
    return isRealPhone ? cleanDigits : jid;
  }
  return jid || phone;
}
