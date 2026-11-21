import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_SNAPSHOT = () => ({
  experiences: [],
  knowledge: [],
  hypotheses: [],
  strategies: [],
  experiments: [],
  regressions: [],
  relationships: {},
  proposals: []
});

const TABLES = [
  'lia_experiences',
  'lia_knowledge',
  'lia_hypotheses',
  'lia_strategies',
  'lia_experiments',
  'lia_regressions',
  'lia_relationships',
  'lia_improvement_proposals'
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Persistência durável do Learning Engine (Supabase backend-only + fallback local atômico).
 */
export class LiaLearningStore {
  constructor({
    client = null,
    filePath = './data/lia-learning.json',
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
      if (!isPlainObject(parsed)) throw new Error('invalid_learning_snapshot');
      return {
        experiences: Array.isArray(parsed.experiences) ? parsed.experiences : [],
        knowledge: Array.isArray(parsed.knowledge) ? parsed.knowledge : [],
        hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [],
        strategies: Array.isArray(parsed.strategies) ? parsed.strategies : [],
        experiments: Array.isArray(parsed.experiments) ? parsed.experiments : [],
        regressions: Array.isArray(parsed.regressions) ? parsed.regressions : [],
        relationships: isPlainObject(parsed.relationships) ? parsed.relationships : {},
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : []
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
    const payload = {
      ...this.snapshot,
      experiences: this.snapshot.experiences.slice(-1000)
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
        await Promise.all(TABLES.map(tbl => this.client.select(tbl, 'select=id&limit=1')));
        this.mode = 'supabase';
        this.loaded = true;
        return this;
      } catch (error) {
        this.remoteError = String(error?.code || error?.name || 'lia_learning_supabase_unavailable');
        if (!this.allowLocalFallback) {
          this.mode = 'unavailable';
          this.loaded = false;
          this.logger.error?.(`[lia-learning] Supabase indisponível (${this.remoteError}); learning em modo fail-closed.`);
          return this;
        }
        this.logger.warn?.(`[lia-learning] Supabase indisponível (${this.remoteError}); usando fallback local explícito.`);
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
      this.logger.error?.(`[lia-learning] arquivo local corrompido (${error?.code || error?.name || 'corrupt'}); operação bloqueada.`);
    }
    return this;
  }

  _assertAvailable() {
    if (!this.available) throw new Error('lia_learning_store_unavailable');
  }

  async insertExperienceIdempotent(record) {
    this._assertAvailable();
    if (this.remoteEnabled) {
      try {
        const inserted = await this.client.request('lia_experiences', {
          method: 'POST',
          body: [record],
          prefer: 'return=representation'
        });
        if (Array.isArray(inserted) && inserted[0]) return { experience: inserted[0], created: true };
        throw new Error('lia_experience_insert_not_confirmed');
      } catch (error) {
        if (!/\b409\b|duplicate key|unique constraint/i.test(String(error?.message || ''))) throw error;
        const existing = await this.client.select('lia_experiences', `select=*&deduplication_key=eq.${encodeURIComponent(record.deduplication_key)}&limit=1`);
        if (Array.isArray(existing) && existing[0]) return { experience: existing[0], created: false };
        throw error;
      }
    }
    return this._serial(async () => {
      const existing = this.snapshot.experiences.find(item => item.deduplication_key === record.deduplication_key);
      if (existing) return { experience: clone(existing), created: false };
      this.snapshot.experiences.push(clone(record));
      await this._saveLocal();
      return { experience: clone(record), created: true };
    });
  }

  async listCollection(collection, tableName, limit = 200) {
    this._assertAvailable();
    if (this.remoteEnabled) {
      const rows = await this.client.select(tableName, `select=*&order=created_at.desc&limit=${Math.max(1, Math.min(1000, Number(limit) || 200))}`);
      return Array.isArray(rows) ? rows : [];
    }
    return clone(this.snapshot[collection] || []);
  }

  async getFromCollection(collection, tableName, id) {
    this._assertAvailable();
    const safeId = String(id || '').trim();
    if (!safeId) return null;
    if (this.remoteEnabled) {
      const rows = await this.client.select(tableName, `select=*&id=eq.${encodeURIComponent(safeId)}&limit=1`);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }
    const found = (this.snapshot[collection] || []).find(item => item.id === safeId);
    return found ? clone(found) : null;
  }

  async upsertInCollection(collection, tableName, record) {
    this._assertAvailable();
    const row = { ...record, updated_at: new Date(this.now()).toISOString() };
    if (this.remoteEnabled) {
      await this.client.upsert(tableName, [row], 'id');
      return clone(row);
    }
    return this._serial(async () => {
      const list = this.snapshot[collection];
      const idx = list.findIndex(item => item.id === row.id);
      if (idx >= 0) list[idx] = clone(row);
      else list.push(clone(row));
      await this._saveLocal();
      return clone(row);
    });
  }

  async getRelationship(id) {
    this._assertAvailable();
    const safeId = String(id || '').trim();
    if (!safeId) return null;
    if (this.remoteEnabled) {
      const rows = await this.client.select('lia_relationships', `select=*&id=eq.${encodeURIComponent(safeId)}&limit=1`);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }
    return this.snapshot.relationships[safeId] ? clone(this.snapshot.relationships[safeId]) : null;
  }

  async upsertRelationship(record) {
    this._assertAvailable();
    const row = { ...record, updated_at: new Date(this.now()).toISOString() };
    if (this.remoteEnabled) {
      await this.client.upsert('lia_relationships', [row], 'id');
      return clone(row);
    }
    return this._serial(async () => {
      this.snapshot.relationships[row.id] = clone(row);
      await this._saveLocal();
      return clone(row);
    });
  }

  async purgeExpiredExperiences(nowMs = this.now()) {
    this._assertAvailable();
    if (this.remoteEnabled) {
      const isoNow = new Date(nowMs).toISOString();
      await this.client.request('lia_experiences', {
        method: 'DELETE',
        query: `expires_at=lt.${encodeURIComponent(isoNow)}`
      }).catch(() => {});
      return 0;
    }
    return this._serial(async () => {
      const before = this.snapshot.experiences.length;
      this.snapshot.experiences = this.snapshot.experiences.filter(exp => {
        if (!exp.expires_at) return true;
        const ts = Date.parse(exp.expires_at);
        return !Number.isFinite(ts) || ts > nowMs;
      });
      const removed = before - this.snapshot.experiences.length;
      if (removed > 0) await this._saveLocal();
      return removed;
    });
  }
}
