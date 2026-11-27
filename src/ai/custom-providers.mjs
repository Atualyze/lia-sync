import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { maskSecretValue } from '../api-settings.mjs';
import { decryptSecret, encryptSecret, hasSecretEncryptionKey, isEncryptedSecret, needsReencryption } from '../security/secrets.mjs';

const PROJECTION_KEY = 'custom_ai_providers';
const BUILTIN_IDS = new Set(['gemini', 'groq', 'nvidia', 'openrouter', 'qwen', 'openai', 'cloudflare']);
const SLUG_RE = /^[a-z][a-z0-9_-]{1,31}$/;

let activeRegistry = new Map();

export function getCustomProvider(id = '') {
  return activeRegistry.get(String(id || '').trim().toLowerCase()) || null;
}
export function listCustomProviders() {
  return [...activeRegistry.values()];
}
export function getCustomProviderPricingRates() {
  const rates = [];
  for (const p of activeRegistry.values()) {
    if (p.defaultModel && Number.isFinite(p.inputUsdPerMillion) && Number.isFinite(p.outputUsdPerMillion)) {
      rates.push({ provider: p.id, model: p.defaultModel, inputUsdPerMillion: p.inputUsdPerMillion, outputUsdPerMillion: p.outputUsdPerMillion });
    }
    if (Number.isFinite(p.inputUsdPerMillion) && Number.isFinite(p.outputUsdPerMillion)) {
      rates.push({ provider: p.id, model: '*', inputUsdPerMillion: p.inputUsdPerMillion, outputUsdPerMillion: p.outputUsdPerMillion });
    }
  }
  return rates;
}

function normalizeProvider(input = {}, existing = null) {
  const id = String(input.id || existing?.id || '').trim().toLowerCase();
  if (!SLUG_RE.test(id)) throw new Error('invalid_provider_id');
  if (BUILTIN_IDS.has(id)) throw new Error('reserved_provider_id');
  const name = String(input.name || existing?.name || id).trim().slice(0, 80);
  const rawUrl = String(input.baseUrl ?? existing?.baseUrl ?? '').trim();
  let parsedUrl;
  try { parsedUrl = new URL(rawUrl); } catch { throw new Error('invalid_provider_base_url'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('invalid_provider_base_url');
  const baseUrl = rawUrl.replace(/\/$/, '');
  const defaultModel = String(input.defaultModel ?? existing?.defaultModel ?? '').trim().slice(0, 140);
  if (!defaultModel) throw new Error('provider_default_model_required');
  const rawKey = input.apiKey;
  const apiKey = rawKey === '__CLEAR__'
    ? ''
    : (typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim().slice(0, 512) : (existing?.apiKey || ''));
  const parseRate = (value, fallback) => {
    if (value === '' || value === null || value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error('invalid_provider_rate');
    return number;
  };
  return {
    id,
    name,
    baseUrl,
    apiKey,
    defaultModel,
    inputUsdPerMillion: parseRate(input.inputUsdPerMillion, existing?.inputUsdPerMillion ?? null),
    outputUsdPerMillion: parseRate(input.outputUsdPerMillion, existing?.outputUsdPerMillion ?? null),
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : (existing ? existing.enabled !== false : true),
    updatedAt: new Date().toISOString()
  };
}

export class CustomProviderStore {
  constructor({ client = null, filePath = './data/custom-ai-providers.json', logger = console, secretEncryptionKey } = {}) {
    this.client = client;
    this.filePath = filePath;
    this.logger = logger;
    this.secretEncryptionKey = secretEncryptionKey;
    this.providers = new Map();
    this.mode = 'local';
  }
  _syncGlobalRegistry() {
    activeRegistry = new Map(this.providers);
  }
  _context(id) {
    return 'custom-ai-provider:' + id;
  }
  _serialize(providers) {
    return [...providers.values()].map(provider => ({
      ...provider,
      apiKey: provider.apiKey
        ? encryptSecret(provider.apiKey, { key: this.secretEncryptionKey, context: this._context(provider.id) })
        : ''
    }));
  }
  async _saveLocal(serializedProviders) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = this.filePath + '.tmp-' + process.pid + '-' + crypto.randomUUID().slice(0, 8);
    try {
      await fs.writeFile(tmp, JSON.stringify({ providers: serializedProviders }, null, 2), 'utf8', { mode: 0o600 });
      await fs.chmod(tmp, 0o600).catch(() => {});
      await fs.rename(tmp, this.filePath);
      await fs.chmod(this.filePath, 0o600).catch(() => {});
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }
  async _persist(providers = this.providers) {
    const serialized = this._serialize(providers);
    if (this.client?.enabled && this.mode === 'supabase') {
      await this.client.upsert('runtime_projections', [{
        key: PROJECTION_KEY,
        payload: { providers: serialized },
        updated_at: new Date().toISOString()
      }], 'key');
    } else {
      await this._saveLocal(serialized);
    }
  }
  async _readLocal() {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return Array.isArray(raw?.providers) ? raw.providers : [];
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }
  async load() {
    let loaded = [];
    if (this.client?.enabled) {
      try {
        const rows = await this.client.select('runtime_projections', 'select=key,payload,updated_at&key=eq.' + encodeURIComponent(PROJECTION_KEY) + '&limit=1');
        this.mode = 'supabase';
        const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
        if (Array.isArray(row?.payload?.providers)) loaded = row.payload.providers;
      } catch (error) {
        this.logger.warn?.('[custom-providers] Supabase indisponível (' + (error?.code || error?.name || 'err') + '); usando fallback local.');
        loaded = await this._readLocal().catch(() => []);
        this.mode = 'local';
      }
    } else {
      loaded = await this._readLocal().catch(() => []);
      this.mode = 'local';
    }
    this.providers.clear();
    let needsPersistence = false;
    let legacyPlaintextCount = 0;
    let rotatedCount = 0;
    for (const item of loaded) {
      try {
        const storedKey = String(item?.apiKey || '');
        let apiKey = storedKey;
        if (isEncryptedSecret(storedKey)) {
          apiKey = decryptSecret(storedKey, { key: this.secretEncryptionKey, context: this._context(item.id) });
          if (needsReencryption(storedKey, { key: this.secretEncryptionKey })) { needsPersistence = true; rotatedCount += 1; }
        } else if (storedKey) {
          legacyPlaintextCount += 1;
          if (hasSecretEncryptionKey(this.secretEncryptionKey)) needsPersistence = true;
        }
        const normalized = normalizeProvider({ ...item, apiKey });
        this.providers.set(normalized.id, normalized);
      } catch (error) {
        this.logger.error?.('[custom-providers] provedor ignorado por falha ao abrir credencial (' + (error?.code || error?.message || 'err') + ').');
      }
    }
    this._syncGlobalRegistry();
    if (needsPersistence) {
      try {
        await this._persist();
        this.logger.info?.('[custom-providers] credenciais legadas migradas para armazenamento criptografado.');
        if (rotatedCount > 0) this.logger.info?.('[custom-providers] ' + rotatedCount + ' credencial(is) recriptografada(s) com a chave atual.');
      } catch (error) {
        this.logger.error?.('[custom-providers] migração de credenciais não concluída (' + (error?.code || error?.message || 'err') + ').');
      }
    } else if (legacyPlaintextCount > 0) {
      this.logger.warn?.('[custom-providers] ' + legacyPlaintextCount + ' credencial(is) legada(s) ainda sem criptografia; configure API_SECRETS_ENCRYPTION_KEY para migrá-las.');
    }
    return this;
  }
  listSafe() {
    return [...this.providers.values()].map(provider => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      inputUsdPerMillion: provider.inputUsdPerMillion,
      outputUsdPerMillion: provider.outputUsdPerMillion,
      enabled: provider.enabled,
      configured: Boolean(provider.enabled && provider.apiKey && provider.baseUrl),
      maskedKey: maskSecretValue(provider.apiKey),
      updatedAt: provider.updatedAt
    }));
  }
  async upsert(input = {}) {
    const id = String(input.id || '').trim().toLowerCase();
    const normalized = normalizeProvider(input, this.providers.get(id) || null);
    const next = new Map(this.providers);
    next.set(normalized.id, normalized);
    await this._persist(next);
    this.providers = next;
    this._syncGlobalRegistry();
    return this.listSafe().find(provider => provider.id === normalized.id);
  }
  async remove(id) {
    const key = String(id || '').trim().toLowerCase();
    if (!this.providers.has(key)) return false;
    const next = new Map(this.providers);
    next.delete(key);
    await this._persist(next);
    this.providers = next;
    this._syncGlobalRegistry();
    return true;
  }
}
