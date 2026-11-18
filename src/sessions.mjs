import fs from 'node:fs/promises'; import path from 'node:path';
import { OWNER_SELF_KEY, isOwnerKey, isOwnerContact, normalizeOwnerKey } from './core/identity.mjs';
const mask = (p='') => { const s=String(p); return s.length > 5 ? `${s.slice(0,3)}***${s.slice(-2)}` : '***'; };
export function normalizePhone(raw = '') {
  let p = String(raw || '').trim();
  const isSim = p.startsWith('sim:');
  if (isSim) p = p.slice(4);
  if (isOwnerKey(p)) {
    const key = normalizeOwnerKey(p);
    return isSim ? `sim:${key}` : key;
  }
  if (/@lid$/i.test(p)) return isSim ? `sim:${p}` : p;
  const digits = p.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    const num = digits.slice(4);
    if (/^[6-9]/.test(num)) {
      const normalized = `55${ddd}9${num}`;
      return isSim ? `sim:${normalized}` : normalized;
    }
  }
  if (digits.length === 10) {
    const ddd = digits.slice(0, 2);
    const num = digits.slice(2);
    if (/^[6-9]/.test(num)) {
      const normalized = `55${ddd}9${num}`;
      return isSim ? `sim:${normalized}` : normalized;
    }
  }
  if (digits.length === 11) {
    const normalized = `55${digits}`;
    return isSim ? `sim:${normalized}` : normalized;
  }
  const result = digits || p;
  return isSim ? `sim:${result}` : result;
}

export function isValidRealMobilePhone(raw = '') {
  if (!raw || typeof raw !== 'string') return false;
  const p = raw.trim();
  if (p.startsWith('sim:') || isOwnerKey(p) || /@lid$/i.test(p)) return false;
  const digits = p.replace(/\D/g, '');

  // Rejeita padrões fictícios conhecidos
  if (/(\d)\1{5,}/.test(digits)) return false; // 6 dígitos idênticos seguidos
  if (/(?:999998888|977112233|999990000|12345678|87654321)/.test(digits)) return false;

  // Brasil: deve ter DDI 55 + DDD válido + celular
  if (digits.startsWith('55')) {
    const withoutDdi = digits.slice(2);
    if (withoutDdi.length !== 10 && withoutDdi.length !== 11) return false;
    const ddd = parseInt(withoutDdi.slice(0, 2), 10);
    if (ddd < 11 || ddd > 99) return false;
    const num = withoutDdi.slice(2);
    if (withoutDdi.length === 11 && !num.startsWith('9')) return false;
    if (/^(\d)\1+$/.test(num)) return false;
    return true;
  }

  if (digits.length === 11) {
    const ddd = parseInt(digits.slice(0, 2), 10);
    if (ddd < 11 || ddd > 99) return false;
    const num = digits.slice(2);
    if (!num.startsWith('9')) return false;
    if (/^(\d)\1+$/.test(num)) return false;
    return true;
  }

  return false;
}

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
  return raw;
}

export { isOwnerContact, OWNER_SELF_KEY };

export class SessionStore {
  constructor(file, { now = () => Date.now(), ttlMs = 30 * 86400000, logger = console } = {}) {
    this.file = file;
    this.now = now;
    this.ttlMs = ttlMs;
    this.logger = logger;
    this.sessions = {};
    this.saveTimer = null;
    this.saving = null;
    this.queues = new Map();
    this.outboundDispatchClaims = new Set();
  }

  async claimOutboundDispatch(dispatchId) {
    const id = String(dispatchId || '').trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(id) || this.outboundDispatchClaims.has(id)) return false;
    this.outboundDispatchClaims.add(id);
    return true;
  }

  async load() {
    try {
      this.sessions = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!this.sessions || typeof this.sessions !== 'object' || Array.isArray(this.sessions)) {
        this.sessions = {};
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.sessions = {};
      } else {
        const corrupt = `${this.file}.corrupt-${this.now()}`;
        try {
          await fs.rename(this.file, corrupt);
        } catch {}
        this.logger.error?.(`[sessions] arquivo corrompido preservado: ${corrupt}`);
        this.sessions = {};
      }
    }
    this.purge();
    await this.purgeArchives();
    return this.sessions;
  }

  purge() {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;
    for (const [key, s] of Object.entries(this.sessions)) {
      const active = new Date(s.lastUserAt || (Array.isArray(s.history) ? s.updatedAt : s.createdAt || 0)).getTime();
      const human = Boolean(s.human) && this.now() - active < 7 * 86400000;
      const held = Boolean(s.legalHold || s.legal_hold || s.metadata?.legalHold || s.metadata?.legal_hold);
      if (active < cutoff && !human && !held) {
        delete this.sessions[key];
        removed++;
      }
    }
    return removed;
  }

  validateKey(phone) {
    const k = String(phone || '');
    const bare = k.replace(/^sim:/i, '');
    if (
      !isOwnerKey(bare) &&
      !/^\d{8,15}$/.test(k) &&
      !/^sim:\d{8,15}$/.test(k) &&
      !/^\d+@lid$/i.test(k) &&
      !/^sim:\d+@lid$/i.test(k)
    ) {
      throw new Error('phone inválido');
    }
    return k;
  }

  // Chave de sessão derivada do telefone/origem (mesma regra de `get`, sem efeito colateral).
  sessionKey(phone, origin = 'real') {
    const norm = normalizePhone(phone);
    const isSim = origin === 'simulation' || norm.startsWith('sim:');
    const cleanPhone = norm.replace(/^sim:/, '');
    const key = isSim ? `sim:${cleanPhone}` : cleanPhone;
    this.validateKey(key);
    return key;
  }

  /**
   * Consulta somente-leitura: informa se a sessão existe sem criá-la.
   * Usado por rotas que precisam distinguir "não existe" de "existe e vazia".
   */
  has(phone, origin = 'real') {
    const key = this.sessionKey(phone, origin);
    return Object.prototype.hasOwnProperty.call(this.sessions, key) && Boolean(this.sessions[key]);
  }

  get(phone, origin = 'real') {
    const key = this.sessionKey(phone, origin);
    const isSim = key.startsWith('sim:');
    const cleanPhone = key.replace(/^sim:/, '');
    return (this.sessions[key] ||= {
      phone: cleanPhone,
      origin: isSim ? 'simulation' : 'real',
      history: [],
      human: false,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  /**
   * Cria a sessão se ainda não existir e devolve a sessão.
   * Mesma semântica de criação de `get`, exposta com nome explícito de escrita.
   */
  ensure(phone, origin = 'real') {
    return this.get(phone, origin);
  }

  /**
   * Empurra uma mensagem no histórico normalizando `{ role, content, createdAt }`.
   * Aceita as formas legadas `text`/`timestamp` e o papel `model` (convertido para
   * `assistant`) para que o histórico tenha um único formato canônico.
   */
  append(phone, message = {}, origin = 'real') {
    const session = this.get(phone, origin);
    const role = message?.role === 'model' ? 'assistant' : (message?.role || 'assistant');
    const entry = {
      role,
      content: String(message?.content ?? message?.text ?? ''),
      createdAt: message?.createdAt || message?.timestamp || new Date(this.now()).toISOString()
    };
    for (const [key, value] of Object.entries(message || {})) {
      if (['role', 'content', 'text', 'createdAt', 'timestamp'].includes(key)) continue;
      entry[key] = value;
    }
    if (!Array.isArray(session.history)) session.history = [];
    session.history.push(entry);
    this.markDirty();
    return entry;
  }

  touch(s) {
    s.updatedAt = new Date(this.now()).toISOString();
  }

  markDirty() {
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.flush().catch((e) => {
        this.logger.error?.('[sessions] falha ao agendar gravação', e?.message || e);
      });
    }, 500);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty = true;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        while (this.dirty) {
          this.dirty = false;
          const tmp = `${this.file}.tmp`;
          await fs.writeFile(tmp, JSON.stringify(this.sessions));
          await fs.rename(tmp, this.file);
        }
      } catch (e) {
        this.logger.error?.('[sessions] falha de gravação', e?.message || e);
        throw e;
      } finally {
        this.saving = null;
      }
    })();
    return this.saving;
  }

  enqueue(phone, fn) {
    const norm = normalizePhone(phone);
    const key = String(norm.replace(/^sim:/, ''));
    const prior = this.queues.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    let tracked;
    tracked = next.finally(() => {
      if (this.queues.get(key) === tracked) this.queues.delete(key);
    });
    this.queues.set(key, tracked);
    return tracked;
  }

  async purgeArchives() {
    const archiveDir = path.join(path.dirname(this.file), 'archive');
    let names;
    try {
      names = await fs.readdir(archiveDir);
    } catch (e) {
      if (e.code === 'ENOENT') return 0;
      throw e;
    }
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(archiveDir, name);
      try {
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        const session = record.session || {};
        const archivedAt = new Date(record.archivedAt || '').getTime();
        const metadata = session.metadata || {};
        const recordMetadata = record.metadata || {};
        const held = Boolean(
          record.legalHold ||
            record.legal_hold ||
            recordMetadata.legalHold ||
            recordMetadata.legal_hold ||
            session.legalHold ||
            session.legal_hold ||
            metadata.legalHold ||
            metadata.legal_hold
        );
        if (!Number.isFinite(archivedAt) || archivedAt >= cutoff || held) continue;
        await fs.unlink(file);
        removed++;
      } catch (e) {
        this.logger.warn?.(`[sessions] arquivo de archive preservado; não foi possível validar: ${name} (${e.message})`);
      }
    }
    return removed;
  }

  async archive(phone, reason = '') {
    const norm = normalizePhone(phone);
    const key = this.validateKey(norm);
    if (key.startsWith('sim:')) {
      const s = this.sessions[key];
      delete this.sessions[key];
      this.markDirty();
      return s;
    }
    const s = this.sessions[key];
    if (!s) return null;
    const archiveDir = path.join(path.dirname(this.file), 'archive');
    await fs.mkdir(archiveDir, { recursive: true });
    const safe = key.replace(/[^0-9]/g, '');
    await fs.writeFile(
      path.join(archiveDir, `${safe}-${this.now()}.json`),
      JSON.stringify({ phone: key, reason, archivedAt: new Date(this.now()).toISOString(), session: s }, null, 2)
    );
    delete this.sessions[key];
    this.markDirty();
    await this.purgeArchives();
    return s;
  }
}
export { mask };
