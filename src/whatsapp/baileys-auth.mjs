import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

const PROJECTION_KEY = 'baileys_auth_creds';

/**
 * Categorias de chaves Signal e Limites por Conta (P0 + P1):
 * - Chaves criptográficas vitais (`session`, `pre-key`, `sender-key`, `app-state-sync-key`, `app-state-sync-version`)
 *   são persistidas no snapshot compacto.
 * - Chaves efêmeras/volumosas (`lid-mapping`, `tctoken`, `device-list`, `sender-key-memory`)
 *   ficam contidas em um LRU em memória com teto rígido para não criar milhares de arquivos
 *   nem inflar o payload do Supabase.
 */
const PERSISTED_KEY_LIMITS = Object.freeze({
  'pre-key': 120,
  'session': 250,
  'sender-key': 80,
  'app-state-sync-key': 40,
  'app-state-sync-version': 15
});

const EPHEMERAL_LRU_MAX = 400;
const EPHEMERAL_TTL_MS = 30 * 60 * 1000;

export class BoundedLruCache {
  constructor({ max = EPHEMERAL_LRU_MAX, ttlMs = EPHEMERAL_TTL_MS } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.ttlMs > 0 && Date.now() - entry.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Promove no LRU
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, at: Date.now() });
    while (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

function trimCategoryMap(catMap, maxEntries) {
  if (!catMap || typeof catMap !== 'object') return {};
  const entries = Object.entries(catMap);
  if (entries.length <= maxEntries) return catMap;
  return Object.fromEntries(entries.slice(-maxEntries));
}

/**
 * AuthState enxuto e controlado para o BaileysProvider da Lia.
 * - Elimina a criação de ~2.000 arquivos soltos do useMultiFileAuthState.
 * - Migra automaticamente um `creds.json` legado se já existir em `authDir`.
 * - Persiste `creds` + chaves Signal essenciais em um único arquivo atômico
 *   (`auth-snapshot.json`) com debounce e backup no Supabase.
 */
export async function createLiaBaileysAuthState({
  authDir = './data/baileys-auth',
  client = null,
  logger = console
} = {}) {
  const resolvedDir = path.resolve(authDir);
  const snapshotPath = path.join(resolvedDir, 'auth-snapshot.json');
  const legacyCredsPath = path.join(resolvedDir, 'creds.json');
  await fs.mkdir(resolvedDir, { recursive: true });

  let creds = null;
  let persistedKeys = {
    'pre-key': {},
    'session': {},
    'sender-key': {},
    'app-state-sync-key': {},
    'app-state-sync-version': {}
  };
  const ephemeralCache = new BoundedLruCache({ max: EPHEMERAL_LRU_MAX, ttlMs: EPHEMERAL_TTL_MS });

  // 1. Tenta carregar do snapshot compacto local
  try {
    const raw = await fs.readFile(snapshotPath, 'utf8');
    const parsed = JSON.parse(raw, BufferJSON.reviver);
    if (parsed?.creds) creds = parsed.creds;
    if (parsed?.keys && typeof parsed.keys === 'object') {
      for (const cat of Object.keys(PERSISTED_KEY_LIMITS)) {
        if (parsed.keys[cat] && typeof parsed.keys[cat] === 'object') {
          persistedKeys[cat] = parsed.keys[cat];
        }
      }
    }
  } catch {}

  // 2. Migração automática caso exista pasta legada do useMultiFileAuthState (creds.json + session-*.json)
  if (!creds) {
    try {
      const legacyRaw = await fs.readFile(legacyCredsPath, 'utf8');
      creds = JSON.parse(legacyRaw, BufferJSON.reviver);
      const files = await fs.readdir(resolvedDir);
      for (const file of files) {
        if (file === 'creds.json' || file === 'auth-snapshot.json' || !file.endsWith('.json')) continue;
        for (const cat of Object.keys(PERSISTED_KEY_LIMITS)) {
          if (file.startsWith(`${cat}-`)) {
            const id = file.slice(cat.length + 1, -5);
            try {
              const val = JSON.parse(await fs.readFile(path.join(resolvedDir, file), 'utf8'), BufferJSON.reviver);
              persistedKeys[cat][id] = val;
            } catch {}
          }
        }
      }
      // Limpa os milhares de arquivinhos legados após absorver em memória
      for (const file of files) {
        if (file !== 'auth-snapshot.json') {
          await fs.rm(path.join(resolvedDir, file), { force: true }).catch(() => {});
        }
      }
      logger.log?.('[baileys:auth] Sessão legada migrada para auth-snapshot.json enxuto.');
    } catch {}
  }

  // 3. Fallback: restaura do Supabase se disco estiver vazio (ex: container recriado)
  if (!creds && client?.enabled) {
    try {
      const rows = await client.select(
        'runtime_projections',
        `select=key,payload&key=eq.${encodeURIComponent(PROJECTION_KEY)}&limit=1`
      );
      const payload = rows?.[0]?.payload;
      if (typeof payload?.snapshotJson === 'string' && payload.snapshotJson.startsWith('{')) {
        const parsed = JSON.parse(payload.snapshotJson, BufferJSON.reviver);
        if (parsed?.creds) creds = parsed.creds;
        if (parsed?.keys && typeof parsed.keys === 'object') {
          for (const cat of Object.keys(PERSISTED_KEY_LIMITS)) {
            if (parsed.keys[cat]) persistedKeys[cat] = parsed.keys[cat];
          }
        }
        logger.log?.('[baileys:auth] Snapshot restaurado do Supabase com sucesso.');
      } else if (typeof payload?.credsJson === 'string' && payload.credsJson.startsWith('{')) {
        creds = JSON.parse(payload.credsJson, BufferJSON.reviver);
        logger.log?.('[baileys:auth] Credenciais restauradas do Supabase com sucesso.');
      }
    } catch (error) {
      logger.warn?.(`[baileys:auth] Falha ao restaurar do Supabase: ${error?.message || error}`);
    }
  }

  if (!creds) {
    creds = initAuthCreds();
  }

  for (const [cat, limit] of Object.entries(PERSISTED_KEY_LIMITS)) {
    persistedKeys[cat] = trimCategoryMap(persistedKeys[cat], limit);
  }

  let flushTimer = null;
  let lastSupabaseSyncAt = 0;

  const flushNow = async ({ forceSupabase = false } = {}) => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    for (const [cat, limit] of Object.entries(PERSISTED_KEY_LIMITS)) {
      persistedKeys[cat] = trimCategoryMap(persistedKeys[cat], limit);
    }
    const serialized = JSON.stringify({ creds, keys: persistedKeys }, BufferJSON.replacer);
    const tmp = `${snapshotPath}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 6)}`;
    try {
      await fs.mkdir(resolvedDir, { recursive: true });
      await fs.writeFile(tmp, serialized, 'utf8');
      await fs.rename(tmp, snapshotPath);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }

    const now = Date.now();
    if (client?.enabled && (forceSupabase || now - lastSupabaseSyncAt > 15_000)) {
      lastSupabaseSyncAt = now;
      try {
        await client.upsert('runtime_projections', [{
          key: PROJECTION_KEY,
          payload: { snapshotJson: serialized },
          updated_at: new Date(now).toISOString()
        }], 'key');
      } catch {}
    }
  };

  const scheduleFlush = (delayMs = 1200) => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushNow();
    }, delayMs);
    flushTimer.unref?.();
  };

  const keys = {
    get: async (type, ids) => {
      const data = {};
      const isPersisted = Object.prototype.hasOwnProperty.call(PERSISTED_KEY_LIMITS, type);
      const bucket = isPersisted ? (persistedKeys[type] || {}) : null;
      for (const id of Array.isArray(ids) ? ids : []) {
        const val = isPersisted ? bucket[id] : ephemeralCache.get(`${type}:${id}`);
        if (val !== undefined && val !== null) {
          data[id] = val;
        }
      }
      return data;
    },
    set: async (data) => {
      if (!data || typeof data !== 'object') return;
      let touchedPersisted = false;
      for (const [category, entries] of Object.entries(data)) {
        if (!entries || typeof entries !== 'object') continue;
        const isPersisted = Object.prototype.hasOwnProperty.call(PERSISTED_KEY_LIMITS, category);
        if (isPersisted) {
          persistedKeys[category] ??= {};
          for (const [id, value] of Object.entries(entries)) {
            if (value === null || value === undefined) {
              delete persistedKeys[category][id];
            } else {
              persistedKeys[category][id] = value;
            }
          }
          persistedKeys[category] = trimCategoryMap(persistedKeys[category], PERSISTED_KEY_LIMITS[category]);
          touchedPersisted = true;
        } else {
          for (const [id, value] of Object.entries(entries)) {
            const cacheKey = `${category}:${id}`;
            if (value === null || value === undefined) ephemeralCache.delete(cacheKey);
            else ephemeralCache.set(cacheKey, value);
          }
        }
      }
      if (touchedPersisted) scheduleFlush(1200);
    }
  };

  const clearAuth = async () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    ephemeralCache.clear();
    persistedKeys = {
      'pre-key': {},
      'session': {},
      'sender-key': {},
      'app-state-sync-key': {},
      'app-state-sync-version': {}
    };
    try {
      await fs.rm(resolvedDir, { recursive: true, force: true });
    } catch {}
    if (client?.enabled) {
      try {
        await client.upsert('runtime_projections', [{
          key: PROJECTION_KEY,
          payload: { snapshotJson: null, credsJson: null },
          updated_at: new Date().toISOString()
        }], 'key');
      } catch {}
    }
  };

  const getCacheStats = () => ({
    ephemeralKeysInRam: ephemeralCache.size,
    persistedSessions: Object.keys(persistedKeys.session || {}).length,
    persistedPreKeys: Object.keys(persistedKeys['pre-key'] || {}).length
  });

  // Garante que o snapshot enxuto inicial esteja gravado se veio de migração
  await flushNow({ forceSupabase: false });

  return {
    state: { creds, keys },
    saveCreds: () => flushNow({ forceSupabase: true }),
    clearAuth,
    getCacheStats
  };
}
