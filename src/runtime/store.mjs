import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_SNAPSHOT = () => ({
  identity: null,
  goals: [],
  events: [],
  commitments: [],
  runtimeState: null
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Persistência durável da fundação do Lia Runtime.
 *
 * Quando o Supabase está configurado, usa as tabelas dedicadas backend-only
 * (`lia_identity`, `lia_goals`, `lia_events`, `lia_commitments`, `lia_runtime_state`)
 * e falha fechado caso a migration ainda não tenha sido aplicada (a menos que
 * `allowLocalFallback` seja explicitamente habilitado em instância única).
 * Sem Supabase configurado, persiste atomicamente em JSON dentro de `data/`.
 */
export class LiaRuntimeStore {
  constructor({
    client = null,
    filePath = './data/lia-runtime.json',
    allowLocalFallback = false,
    logger = console,
    now = () => Date.now()
  } = {}) {
    this.client = client;
    this.filePath = filePath;
    this.allowLocalFallback = allowLocalFallback === true;
    this.logger = logger;
    this.now = now;
    this.mode = 'local';
    this.remoteError = null;
    this.localCorrupt = false;
    this.loaded = false;
    this.writing = Promise.resolve();
    this.snapshot = DEFAULT_SNAPSHOT();
  }

  get remoteEnabled() {
    return Boolean(this.client?.enabled && this.mode === 'supabase');
  }

  get available() {
    if (this.mode === 'unavailable') return false;
    if (!this.remoteEnabled && this.localCorrupt) return false;
    return this.loaded;
  }

  _serial(fn) {
    this.writing = this.writing.catch(() => {}).then(fn);
    return this.writing;
  }

  async _readLocalFile() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error('invalid_runtime_snapshot');
      return {
        identity: isPlainObject(parsed.identity) ? parsed.identity : null,
        goals: Array.isArray(parsed.goals) ? parsed.goals : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        commitments: Array.isArray(parsed.commitments) ? parsed.commitments : [],
        runtimeState: isPlainObject(parsed.runtimeState) ? parsed.runtimeState : null
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return DEFAULT_SNAPSHOT();
      throw error;
    }
  }

  async _saveLocal() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const maxEvents = 500;
    const trimmedEvents = this.snapshot.events.length > maxEvents
      ? this.snapshot.events.slice(-maxEvents)
      : this.snapshot.events;
    const payload = {
      ...this.snapshot,
      events: trimmedEvents
    };
    try {
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async load() {
    this.remoteError = null;
    this.localCorrupt = false;

    if (this.client?.enabled) {
      try {
        await Promise.all([
          this.client.select('lia_identity', 'select=id&limit=1'),
          this.client.select('lia_goals', 'select=id&limit=1'),
          this.client.select('lia_events', 'select=id&limit=1'),
          this.client.select('lia_commitments', 'select=id&limit=1'),
          this.client.select('lia_runtime_state', 'select=id&limit=1')
        ]);
        this.mode = 'supabase';
        this.loaded = true;
        return this;
      } catch (error) {
        this.remoteError = String(error?.code || error?.name || 'lia_runtime_supabase_unavailable');
        if (!this.allowLocalFallback) {
          this.mode = 'unavailable';
          this.loaded = false;
          this.logger.error?.(`[lia-runtime] Supabase indisponível (${this.remoteError}); runtime em modo fail-closed.`);
          return this;
        }
        this.logger.warn?.(`[lia-runtime] Supabase indisponível (${this.remoteError}); usando fallback local explícito.`);
      }
    }

    try {
      this.snapshot = await this._readLocalFile();
      this.mode = 'local';
      this.loaded = true;
    } catch (error) {
      this.localCorrupt = true;
      this.mode = 'unavailable';
      this.loaded = false;
      this.logger.error?.(`[lia-runtime] arquivo local corrompido (${error?.code || error?.name || 'corrupt'}); operação bloqueada.`);
    }
    return this;
  }

  _assertAvailable() {
    if (!this.available) throw new Error('lia_runtime_store_unavailable');
  }

  // ---- Identity ----
  async getIdentity() {
    this._assertAvailable();
    if (this.remoteEnabled) {
      const rows = await this.client.select('lia_identity', 'select=*&id=eq.primary&limit=1');
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }
    return this.snapshot.identity ? clone(this.snapshot.identity) : null;
  }

  async saveIdentity(record) {
    this._assertAvailable();
    const row = { ...record, id: 'primary', updated_at: new Date(this.now()).toISOString() };
    if (this.remoteEnabled) {
      await this.client.upsert('lia_identity', [row], 'id');
      return clone(row);
    }
    return this._serial(async () => {
      this.snapshot.identity = clone(row);
      await this._saveLocal();
      return clone(row);
    });
  }

  // ---- Runtime Lifecycle State ----
  async getRuntimeState() {
    this._assertAvailable();
    if (this.remoteEnabled) {
      const rows = await this.client.select('lia_runtime_state', 'select=*&id=eq.primary&limit=1');
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }
    return this.snapshot.runtimeState ? clone(this.snapshot.runtimeState) : null;
  }

  async saveRuntimeState(record) {
    this._assertAvailable();
    const row = { ...record, id: 'primary', updated_at: new Date(this.now()).toISOString() };
    if (this.remoteEnabled) {
      await this.client.upsert('lia_runtime_state', [row], 'id');
      return clone(row);
    }
    return this._serial(async () => {
      this.snapshot.runtimeState = clone(row);
      await this._saveLocal();
      return clone(row);
    });
  }

  // ---- Goals ----
  async listGoals() {
    this._assertAvailable();
    if (this.remoteEnabled) {
      const rows = await this.client.select('lia_goals', 'select=*&order=created_at.desc&limit=200');
      return Array.isArray(rows) ? rows : [];
    }
    return clone(this.snapshot.goals);
  }

  async getGoal(id) {
    this._assertAvailable();
    const safeId = String(id || '').trim();
    if (!safeId) return null;
    if (this.remoteEnabled) {
      const rows = await this.client.select('lia_goals', `select=*&id=eq.${encodeURIComponent(safeId)}&limit=1`);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }
    const found = this.snapshot.goals.find(g => g.id === safeId);
    return found ? clone(found) : null;
  }

  async upsertGoal(goal) {
    this._assertAvailable();
    const row = { ...goal, updated_at: new Date(this.now()).toISOString() };
    if (this.remoteEnabled) {
      await this.client.upsert('lia_goals', [row], 'id');
      return clone(row);
    }
    return this._serial(async () => {
      const idx = this.snapshot.goals.findIndex(g => g.id === row.id);
      if (idx >= 0) this.snapshot.goals[idx] = clone(row);
      else this.snapshot.goals.push(clone(row));
      await this._saveLocal();
      return clone(row);
    });
  }

  // ---- Events ----
  async insertEventIdempotent(event) {
    this._assertAvailable();
    if (this.remoteEnabled) {
      try {
        const inserted = await this.client.request('lia_events', {
          method: 'POST',
          body: [event],
          prefer: 'return=representation'
        });
        if (Array.isArray(inserted) && inserted[0]) return { event: inserted[0], created: true };
        throw new Error('lia_event_insert_not_confirmed');
      } catch (error) {
        if (!/\b409\b|duplicate key|unique constraint/i.test(String(error?.message || ''))) throw error;
        const existing = await this.client.select('lia_events', `select=*&deduplication_key=eq.${encodeURIComponent(event.deduplication_key)}&limit=1`);
        if (Array.isArray(existing) && existing[0]) return { event: existing[0], created: false };
        throw error;
      }
    }
    return this._serial(async () => {
      const existing = this.snapshot.events.find(item => item.deduplication_key === event.deduplication_key);
      if (existing) return { event: clone(existing), created: false };
      this.snapshot.events.push(clone(event));
      await this._saveLocal();
      return { event: clone(event), created: true };
    });
  }

  async listEvents({ statuses = null, limit = 100 } = {}) {
    this._assertAvailable();
    if (this.remoteEnabled) {
      const statusFilter = Array.isArray(statuses) && statuses.length
        ? `&status=in.(${statuses.map(s => encodeURIComponent(s)).join(',')})`
        : '';
      const rows = await this.client.select('lia_events', `select=*${statusFilter}&order=occurred_at.asc&limit=${Math.max(1, Math.min(500, Number(limit) || 100))}`);
      return Array.isArray(rows) ? rows : [];
    }
    let items = this.snapshot.events;
    if (Array.isArray(statuses) && statuses.length) {
      const set = new Set(statuses);
      items = items.filter(item => set.has(item.status));
    }
    return clone(items.slice(0, Math.max(1, Number(limit) || 100)));
  }

  async updateEvent(id, patch) {
    this._assertAvailable();
    const safeId = String(id || '').trim();
    const updates = { ...patch, updated_at: new Date(this.now()).toISOString() };
    if (this.remoteEnabled) {
      const rows = await this.client.patch('lia_events', `id=eq.${encodeURIComponent(safeId)}`, updates);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }
    return this._serial(async () => {
      const idx = this.snapshot.events.findIndex(item => item.id === safeId);
      if (idx < 0) return null;
      this.snapshot.events[idx] = { ...this.snapshot.events[idx], ...clone(updates) };
      await this._saveLocal();
      return clone(this.snapshot.events[idx]);
    });
  }

  // ---- Commitments ----
  async listCommitments() {
    this._assertAvailable();
    if (this.remoteEnabled) {
      const rows = await this.client.select('lia_commitments', 'select=*&order=due_at.asc&limit=200');
      return Array.isArray(rows) ? rows : [];
    }
    return clone(this.snapshot.commitments);
  }

  async getCommitment(id) {
    this._assertAvailable();
    const safeId = String(id || '').trim();
    if (!safeId) return null;
    if (this.remoteEnabled) {
      const rows = await this.client.select('lia_commitments', `select=*&id=eq.${encodeURIComponent(safeId)}&limit=1`);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }
    const found = this.snapshot.commitments.find(c => c.id === safeId);
    return found ? clone(found) : null;
  }

  async upsertCommitment(commitment) {
    this._assertAvailable();
    const row = { ...commitment, updated_at: new Date(this.now()).toISOString() };
    if (this.remoteEnabled) {
      await this.client.upsert('lia_commitments', [row], 'id');
      return clone(row);
    }
    return this._serial(async () => {
      const idx = this.snapshot.commitments.findIndex(c => c.id === row.id);
      if (idx >= 0) this.snapshot.commitments[idx] = clone(row);
      else this.snapshot.commitments.push(clone(row));
      await this._saveLocal();
      return clone(row);
    });
  }
}
