import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';

const PROJECTION_ID = 'api_runtime_settings';

/**
 * Campos de API e provedores configuráveis dinamicamente pelo painel administrativo
 * sem precisar entrar na VPS ou reiniciar o contêiner.
 * Segredos (`secret: true`) são write-only: nunca são retornados em texto claro ao browser.
 */
export const API_SETTING_FIELDS = Object.freeze([
  // Provedores de IA
  { key: 'geminiKey', label: 'Google Gemini API Key', group: 'ai', secret: true },
  { key: 'geminiFreeKey', label: 'Google Gemini Free Key', group: 'ai', secret: true },
  { key: 'openrouterKey', label: 'OpenRouter API Key', group: 'ai', secret: true },
  { key: 'openrouterBaseUrl', label: 'OpenRouter Base URL', group: 'ai', secret: false, isUrl: true },
  { key: 'qwenKey', label: 'Qwen / DashScope API Key', group: 'ai', secret: true },
  { key: 'qwenBaseUrl', label: 'Qwen Base URL', group: 'ai', secret: false, isUrl: true },
  { key: 'openaiKey', label: 'OpenAI API Key', group: 'ai', secret: true },
  { key: 'groqKey', label: 'Groq API Key', group: 'ai', secret: true },
  { key: 'cloudflareAccountId', label: 'Cloudflare Account ID', group: 'ai', secret: false },
  { key: 'cloudflareApiToken', label: 'Cloudflare Workers AI Token', group: 'ai', secret: true },
  // WhatsApp / Evolution API
  { key: 'evolutionUrl', label: 'Evolution API URL', group: 'whatsapp', secret: false, isUrl: true },
  { key: 'evolutionKey', label: 'Evolution API Key', group: 'whatsapp', secret: true },
  { key: 'evolutionInstance', label: 'Evolution Instance', group: 'whatsapp', secret: false },
  // Integrações & API v1
  { key: 'chatwootInternalUrl', label: 'Chatwoot Internal URL', group: 'integrations', secret: false, isUrl: true },
  { key: 'faqUrl', label: 'FAQ Remota URL', group: 'integrations', secret: false, isUrl: true },
  { key: 'apiV1RateLimitPerMin', label: 'API v1 Rate Limit (req/min)', group: 'integrations', secret: false, isNumber: true }
]);

const FIELD_MAP = new Map(API_SETTING_FIELDS.map(f => [f.key, f]));

export function maskSecretValue(value = '') {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-3)}`;
}

function validateFieldValue(field, rawValue) {
  if (rawValue === null || rawValue === '__CLEAR__') return { clear: true };
  if (field.isNumber) {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n < 10 || n > 10000) throw new Error(`invalid_number:${field.key}`);
    return { value: Math.round(n) };
  }
  const str = String(rawValue || '').trim();
  if (!str) return { skip: true };
  if (str.length > 512) throw new Error(`value_too_long:${field.key}`);
  if (field.isUrl) {
    let parsed;
    try { parsed = new URL(str); } catch { throw new Error(`invalid_url:${field.key}`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`invalid_url_protocol:${field.key}`);
    return { value: str.replace(/\/$/, '') };
  }
  return { value: str };
}

export class ApiSettingsStore {
  constructor({
    client = null,
    filePath = './data/api-settings.json',
    targetConfig = config,
    logger = console,
    now = () => Date.now()
  } = {}) {
    this.client = client;
    this.filePath = filePath;
    this.targetConfig = targetConfig;
    this.logger = logger;
    this.now = now;
    this.envBaseline = {};
    for (const field of API_SETTING_FIELDS) {
      this.envBaseline[field.key] = targetConfig[field.key];
    }
    this.overrides = {};
    this.updatedAt = null;
    this.mode = 'local';
  }

  _applyToRuntime() {
    for (const field of API_SETTING_FIELDS) {
      const hasOverride = Object.prototype.hasOwnProperty.call(this.overrides, field.key);
      this.targetConfig[field.key] = hasOverride ? this.overrides[field.key] : this.envBaseline[field.key];
    }
  }

  async _readLocal() {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return {
        overrides: raw?.overrides && typeof raw.overrides === 'object' ? raw.overrides : {},
        updatedAt: raw?.updatedAt || null
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { overrides: {}, updatedAt: null };
      throw error;
    }
  }

  async _saveLocal() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ overrides: this.overrides, updatedAt: this.updatedAt }, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async load() {
    if (this.client?.enabled) {
      try {
        const rows = await this.client.select('runtime_projections', `select=id,payload,updated_at&id=eq.${encodeURIComponent(PROJECTION_ID)}&limit=1`);
        this.mode = 'supabase';
        const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
        if (row?.payload && typeof row.payload === 'object') {
          this.overrides = row.payload.overrides && typeof row.payload.overrides === 'object' ? { ...row.payload.overrides } : {};
          this.updatedAt = row.updated_at || null;
        }
        this._applyToRuntime();
        return this;
      } catch (error) {
        this.logger.warn?.(`[api-settings] Supabase indisponível (${error?.code || error?.name || 'err'}); usando fallback local.`);
      }
    }
    try {
      const local = await this._readLocal();
      this.overrides = local.overrides;
      this.updatedAt = local.updatedAt;
      this.mode = 'local';
      this._applyToRuntime();
    } catch (error) {
      this.logger.error?.(`[api-settings] falha ao carregar configurações locais: ${error?.message || error}`);
    }
    return this;
  }

  /**
   * Retorna visão segura para o dashboard: segredos nunca são retornados em claro.
   */
  getSafeView() {
    const items = API_SETTING_FIELDS.map(field => {
      const hasOverride = Object.prototype.hasOwnProperty.call(this.overrides, field.key);
      const effective = this.targetConfig[field.key];
      const configured = Boolean(effective !== undefined && effective !== null && String(effective).trim() !== '');
      const source = hasOverride ? 'panel' : (configured ? 'env' : 'none');
      return {
        key: field.key,
        label: field.label,
        group: field.group,
        secret: field.secret,
        isUrl: Boolean(field.isUrl),
        isNumber: Boolean(field.isNumber),
        configured,
        source,
        value: field.secret ? '' : (effective ?? ''),
        masked: field.secret ? maskSecretValue(effective) : ''
      };
    });
    return {
      mode: this.mode,
      updatedAt: this.updatedAt,
      items
    };
  }

  async update(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('invalid_api_settings_payload');
    }
    const nextOverrides = { ...this.overrides };
    const changedKeys = [];

    for (const [key, rawVal] of Object.entries(patch)) {
      const field = FIELD_MAP.get(key);
      if (!field) continue;
      const validated = validateFieldValue(field, rawVal);
      if (validated.skip) continue;
      if (validated.clear) {
        if (Object.prototype.hasOwnProperty.call(nextOverrides, key)) {
          delete nextOverrides[key];
          changedKeys.push(`${key}:cleared`);
        }
        continue;
      }
      nextOverrides[key] = validated.value;
      changedKeys.push(key);
    }

    this.overrides = nextOverrides;
    this.updatedAt = new Date(this.now()).toISOString();
    this._applyToRuntime();

    if (this.client?.enabled && this.mode === 'supabase') {
      await this.client.upsert('runtime_projections', [{
        id: PROJECTION_ID,
        payload: { overrides: this.overrides },
        updated_at: this.updatedAt
      }], 'id');
    } else {
      await this._saveLocal();
    }

    return { changedKeys, view: this.getSafeView() };
  }
}
