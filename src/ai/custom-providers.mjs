import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { maskSecretValue } from '../api-settings.mjs';

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
      rates.push({
        provider: p.id,
        model: p.defaultModel,
        inputUsdPerMillion: p.inputUsdPerMillion,
        outputUsdPerMillion: p.outputUsdPerMillion
      });
    }
    if (Number.isFinite(p.inputUsdPerMillion) && Number.isFinite(p.outputUsdPerMillion)) {
      rates.push({
        provider: p.id,
        model: '*',
        inputUsdPerMillion: p.inputUsdPerMillion,
        outputUsdPerMillion: p.outputUsdPerMillion
      });
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

  const parseRate = (val, fallback) => {
    if (val === '' || val === null || val === undefined) return fallback;
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) throw new Error('invalid_provider_rate');
    return n;
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
  constructor({
    client = null,
    filePath = './data/custom-ai-providers.json',
    logger = console
  } = {}) {
    this.client = client;
    this.filePath = filePath;
    this.logger = logger;
    this.providers = new Map();
    this.mode = 'local';
  }

  _syncGlobalRegistry() {
    activeRegistry = new Map(this.providers);
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

  async _saveLocal() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ providers: [...this.providers.values()] }, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async _persist() {
    const list = [...this.providers.values()];
    if (this.client?.enabled && this.mode === 'supabase') {
      await this.client.upsert('runtime_projections', [{
        key: PROJECTION_KEY,
        payload: { providers: list },
        updated_at: new Date().toISOString()
      }], 'key');
    } else {
      await this._saveLocal();
    }
  }

  async load() {
    let loaded = [];
    if (this.client?.enabled) {
      try {
        const rows = await this.client.select('runtime_projections', `select=key,payload,updated_at&key=eq.${encodeURIComponent(PROJECTION_KEY)}&limit=1`);
        this.mode = 'supabase';
        const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
        if (Array.isArray(row?.payload?.providers)) loaded = row.payload.providers;
      } catch (error) {
        this.logger.warn?.(`[custom-providers] Supabase indisponível (${error?.code || error?.name || 'err'}); usando fallback local.`);
        loaded = await this._readLocal().catch(() => []);
        this.mode = 'local';
      }
    } else {
      loaded = await this._readLocal().catch(() => []);
      this.mode = 'local';
    }
    this.providers.clear();
    for (const item of loaded) {
      try {
        const norm = normalizeProvider(item);
        this.providers.set(norm.id, norm);
      } catch {}
    }
    this._syncGlobalRegistry();
    return this;
  }

  listSafe() {
    return [...this.providers.values()].map(p => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      defaultModel: p.defaultModel,
      inputUsdPerMillion: p.inputUsdPerMillion,
      outputUsdPerMillion: p.outputUsdPerMillion,
      enabled: p.enabled,
      configured: Boolean(p.enabled && p.apiKey && p.baseUrl),
      maskedKey: maskSecretValue(p.apiKey),
      updatedAt: p.updatedAt
    }));
  }

  async upsert(input = {}) {
    const existing = this.providers.get(String(input.id || '').trim().toLowerCase()) || null;
    const normalized = normalizeProvider(input, existing);
    this.providers.set(normalized.id, normalized);
    this._syncGlobalRegistry();
    await this._persist();
    return this.listSafe().find(p => p.id === normalized.id);
  }

  async remove(id) {
    const key = String(id || '').trim().toLowerCase();
    if (!this.providers.has(key)) return false;
    this.providers.delete(key);
    this._syncGlobalRegistry();
    await this._persist();
    return true;
  }
}
