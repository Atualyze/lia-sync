import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Interface base para adaptadores de armazenamento externos e locais.
 * Permite que componentes operem contra filesystem local (desenvolvimento/fallback)
 * ou bancos remotos como Supabase (produção multi-réplica).
 */
export class StorageAdapter {
  constructor(name = 'base') {
    this.name = name;
  }

  async get(_collection, _key) {
    throw new Error('get() não implementado pelo adaptador');
  }

  async set(_collection, _key, _value, _options = {}) {
    throw new Error('set() não implementado pelo adaptador');
  }

  async delete(_collection, _key) {
    throw new Error('delete() não implementado pelo adaptador');
  }

  async list(_collection, _filter = {}) {
    throw new Error('list() não implementado pelo adaptador');
  }

  async health() {
    return { ok: true, adapter: this.name };
  }
}

/**
 * Adaptador de arquivos locais (JSON em ./data), garantindo escrita atômica com .tmp
 * e isolamento de falhas.
 */
export class FileStorageAdapter extends StorageAdapter {
  constructor(baseDir = './data', { logger = console } = {}) {
    super('file');
    this.baseDir = path.resolve(baseDir);
    this.logger = logger;
  }

  _filePath(collection, key) {
    const safeCollection = String(collection).replace(/[^a-z0-9_-]/gi, '_');
    const safeKey = String(key).replace(/[^a-z0-9_.-]/gi, '_');
    return path.join(this.baseDir, safeCollection, `${safeKey}.json`);
  }

  async get(collection, key) {
    const file = this._filePath(collection, key);
    try {
      const content = await fs.readFile(file, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      this.logger.warn?.(`[storage:file] erro ao ler ${file}: ${err.message}`);
      throw err;
    }
  }

  async set(collection, key, value) {
    const file = this._filePath(collection, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(tmp, file);
    return value;
  }

  async delete(collection, key) {
    const file = this._filePath(collection, key);
    try {
      await fs.unlink(file);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async list(collection) {
    const dir = path.join(this.baseDir, String(collection).replace(/[^a-z0-9_-]/gi, '_'));
    try {
      const files = await fs.readdir(dir);
      const results = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const key = f.replace(/\.json$/, '');
        const val = await this.get(collection, key).catch(() => null);
        if (val !== null) results.push({ key, value: val });
      }
      return results;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async health() {
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      return { ok: true, adapter: 'file', path: this.baseDir };
    } catch (err) {
      return { ok: false, adapter: 'file', error: err.message };
    }
  }
}
