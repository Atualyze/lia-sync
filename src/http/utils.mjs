import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.mjs';
import { isOwnerKey } from '../core/identity.mjs';

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
export function formatPhoneNumber(raw = '') {
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return raw;
  if (digits.startsWith('55') && digits.length >= 12 && digits.length <= 13) {
    const ddd = digits.slice(2, 4);
    const num = digits.slice(4);
    if (num.length === 9) return `+55 (${ddd}) ${num.slice(0, 5)}-${num.slice(5)}`;
    if (num.length === 8) return `+55 (${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`;
  }
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `+${digits}`;
}

export function formatActivityTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  if (isToday) return timeStr;
  if (isYesterday) return `Ontem ${timeStr}`;
  const dateStr = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  return `${dateStr} ${timeStr}`;
}

export function deliveryTarget(job, defaultPhone = '') {
  if (isOwnerKey(job?.phone) || isOwnerKey(job?.jid)) {
    const rawJid = String(job?.jid || '');
    if (rawJid && !isOwnerKey(rawJid)) return rawJid;
    return defaultPhone;
  }
  const jid = String(job?.jid || '');
  return /@lid$/i.test(jid) ? String(job?.phone || jid) : (jid || String(job?.phone || ''));
}
