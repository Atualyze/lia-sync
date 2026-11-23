import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { decryptSecret, encryptSecret, hasSecretEncryptionKey, isEncryptedSecret } from './security/secrets.mjs';

const PROJECTION_ID = 'api_runtime_settings';

export const API_SETTING_FIELDS = Object.freeze([
  { key: 'geminiKey', label: 'Google Gemini API Key', group: 'ai', secret: true },
  { key: 'geminiFreeKey', label: 'Google Gemini Free Key', group: 'ai', secret: true },
  { key: 'openrouterKey', label: 'OpenRouter API Key', group: 'ai', secret: true },
  { key: 'openrouterBaseUrl', label: 'OpenRouter Base URL', group: 'ai', secret: false, isUrl: true },
  { key: 'qwenKey', label: 'Qwen / DashScope API Key', group: 'ai', secret: true },
  { key: 'qwenBaseUrl', label: 'Qwen Base URL', group: 'ai', secret: false, isUrl: true },
  { key: 'nvidiaKey', label: 'NVIDIA NIM API Key', group: 'ai', secret: true },
  { key: 'nvidiaBaseUrl', label: 'NVIDIA NIM API URL', group: 'ai', secret: false, isUrl: true },
  { key: 'openaiKey', label: 'OpenAI API Key', group: 'ai', secret: true },
  { key: 'groqKey', label: 'Groq API Key', group: 'ai', secret: true },
  { key: 'cloudflareAccountId', label: 'Cloudflare Account ID', group: 'ai', secret: false },
  { key: 'cloudflareApiToken', label: 'Cloudflare Workers AI Token', group: 'ai', secret: true },
  { key: 'whatsappProvider', label: 'Provedor WhatsApp (baileys | evolution)', group: 'whatsapp', secret: false },
  { key: 'evolutionUrl', label: 'Evolution API URL', group: 'whatsapp', secret: false, isUrl: true },
  { key: 'evolutionKey', label: 'Evolution API Key', group: 'whatsapp', secret: true },
  { key: 'evolutionInstance', label: 'Evolution Instance', group: 'whatsapp', secret: false },
  { key: 'googleClientId', label: 'Google OAuth Client ID', group: 'google', secret: false },
  { key: 'googleClientSecret', label: 'Google OAuth Client Secret', group: 'google', secret: true },
  { key: 'googleRefreshToken', label: 'Google OAuth Refresh Token', group: 'google', secret: true },
  { key: 'googleServiceAccountEmail', label: 'Google Service Account Email', group: 'google', secret: false },
  { key: 'googleServiceAccountPrivateKey', label: 'Google Service Account Private Key (PEM)', group: 'google', secret: true, maxLength: 8192 },
  { key: 'telegramBotToken', label: 'Telegram Bot Token (@BotFather)', group: 'integrations', secret: true },
  { key: 'telegramAdminChatId', label: 'Telegram Admin Chat ID (use /meu_id no bot)', group: 'integrations', secret: false },
  { key: 'chatwootInternalUrl', label: 'Chatwoot Internal URL', group: 'integrations', secret: false, isUrl: true },
  { key: 'faqUrl', label: 'FAQ Remota URL', group: 'integrations', secret: false, isUrl: true },
  { key: 'apiV1RateLimitPerMin', label: 'API v1 Rate Limit (req/min)', group: 'integrations', secret: false, isNumber: true }
]);

const FIELD_MAP = new Map(API_SETTING_FIELDS.map(field => [field.key, field]));

export function maskSecretValue(value = '') {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '***';
  return s.slice(0, 4) + '***' + s.slice(-3);
}

function validateFieldValue(field, rawValue) {
  if (rawValue === null || rawValue === '__CLEAR__') return { clear: true };
  if (field.isNumber) {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n < 10 || n > 10000) throw new Error('invalid_number:' + field.key);
    return { value: Math.round(n) };
  }
  const str = String(rawValue || '').trim();
  if (!str) return { skip: true };
  const limit = Number(field.maxLength) || 512;
  if (str.length > limit) throw new Error('value_too_long:' + field.key);
  if (field.isUrl) {
    let parsed;
    try { parsed = new URL(str); } catch { throw new Error('invalid_url:' + field.key); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_url_protocol:' + field.key);
    return { value: str.replace(/\/$/, '') };
  }
  return { value: str };
}

export class ApiSettingsStore {
  constructor({ client = null, filePath = './data/api-settings.json', targetConfig = config, logger = console, now = () => Date.now(), secretEncryptionKey } = {}) {
    this.client = client;
    this.filePath = filePath;
    this.targetConfig = targetConfig;
    this.logger = logger;
    this.now = now;
    this.secretEncryptionKey = secretEncryptionKey;
    this.envBaseline = {};
    for (const field of API_SETTING_FIELDS) this.envBaseline[field.key] = targetConfig[field.key];
    this.overrides = {};
    this.updatedAt = null;
    this.mode = 'local';
  }

  _context(key) {
    return 'api-settings:' + key;
  }

  _applyToRuntime() {
    for (const field of API_SETTING_FIELDS) {
      const hasOverride = Object.prototype.hasOwnProperty.call(this.overrides, field.key);
      this.targetConfig[field.key] = hasOverride ? this.overrides[field.key] : this.envBaseline[field.key];
    }
  }

  _serializeOverrides(overrides) {
    const result = { ...overrides };
    for (const field of API_SETTING_FIELDS) {
      if (!field.secret || !Object.prototype.hasOwnProperty.call(result, field.key)) continue;
      const value = String(result[field.key] ?? '');
      if (!value || isEncryptedSecret(value)) continue;
      result[field.key] = encryptSecret(value, { key: this.secretEncryptionKey, context: this._context(field.key) });
    }
    return result;
  }

  async _saveLocal(serializedOverrides, updatedAt) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = this.filePath + '.tmp-' + process.pid + '-' + crypto.randomUUID().slice(0, 8);
    try {
      await fs.writeFile(tmp, JSON.stringify({ overrides: serializedOverrides, updatedAt }, null, 2), 'utf8', { mode: 0o600 });
      await fs.chmod(tmp, 0o600).catch(() => {});
      await fs.rename(tmp, this.filePath);
      await fs.chmod(this.filePath, 0o600).catch(() => {});
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async _persistOverrides(overrides, updatedAt) {
    const serialized = this._serializeOverrides(overrides);
    if (this.client?.enabled && this.mode === 'supabase') {
      await this.client.upsert('runtime_projections', [{
        key: PROJECTION_ID,
        payload: { overrides: serialized },
        updated_at: updatedAt
      }], 'key');
    } else {
      await this._saveLocal(serialized, updatedAt);
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

  async load() {
    if (this.client?.enabled) {
      try {
        const rows = await this.client.select('runtime_projections', 'select=key,payload,updated_at&key=eq.' + encodeURIComponent(PROJECTION_ID) + '&limit=1');
        this.mode = 'supabase';
        const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
        if (row?.payload && typeof row.payload === 'object') {
          this.overrides = row.payload.overrides && typeof row.payload.overrides === 'object' ? { ...row.payload.overrides } : {};
          this.updatedAt = row.updated_at || null;
        }
      } catch (error) {
        this.logger.warn?.('[api-settings] Supabase indisponível (' + (error?.code || error?.name || 'err') + '); usando fallback local.');
      }
    }

    if (this.mode !== 'supabase') {
      try {
        const local = await this._readLocal();
        this.overrides = local.overrides;
        this.updatedAt = local.updatedAt;
        this.mode = 'local';
      } catch (error) {
        this.logger.error?.('[api-settings] falha ao carregar configurações locais: ' + (error?.code || error?.name || 'err'));
      }
    }

    const encryptionReady = hasSecretEncryptionKey(this.secretEncryptionKey);
    let needsPersistence = false;
    let legacyPlaintextCount = 0;
    for (const field of API_SETTING_FIELDS) {
      if (!field.secret) continue;
      if (Object.prototype.hasOwnProperty.call(this.overrides, field.key)) {
        const stored = String(this.overrides[field.key] ?? '');
        this.envBaseline[field.key] = '';
        if (isEncryptedSecret(stored)) {
          try {
            this.overrides[field.key] = decryptSecret(stored, { key: this.secretEncryptionKey, context: this._context(field.key) });
          } catch (error) {
            this.overrides[field.key] = '';
            this.logger.error?.('[api-settings] não foi possível abrir o segredo ' + field.key + '; confira API_SECRETS_ENCRYPTION_KEY (' + error.message + ').');
          }
        } else if (stored) {
          legacyPlaintextCount += 1;
          if (encryptionReady) needsPersistence = true;
        }
      } else {
        const envValue = String(this.envBaseline[field.key] || '').trim();
        if (envValue && encryptionReady) {
          this.overrides[field.key] = envValue;
          this.envBaseline[field.key] = '';
          needsPersistence = true;
        }
      }
    }

    this._applyToRuntime();
    if (needsPersistence) {
      this.updatedAt = new Date(this.now()).toISOString();
      try {
        await this._persistOverrides(this.overrides, this.updatedAt);
        this.logger.info?.('[api-settings] credenciais legadas migradas para armazenamento criptografado (' + (this.mode === 'supabase' ? 'Supabase' : 'local') + ').');
      } catch (error) {
        this.logger.error?.('[api-settings] migração de credenciais não concluída (' + (error?.code || error?.message || 'err') + '). Os valores legados foram mantidos em memória.');
      }
    }
    if (legacyPlaintextCount > 0 && !encryptionReady) {
      this.logger.warn?.('[api-settings] ' + legacyPlaintextCount + ' segredo(s) legado(s) ainda sem criptografia; configure API_SECRETS_ENCRYPTION_KEY para migrá-los.');
    }
    return this;
  }

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
    return { mode: this.mode, updatedAt: this.updatedAt, items };
  }

  async update(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('invalid_api_settings_payload');
    const nextOverrides = { ...this.overrides };
    const changedKeys = [];
    for (const [key, rawVal] of Object.entries(patch)) {
      const field = FIELD_MAP.get(key);
      if (!field) continue;
      const validated = validateFieldValue(field, rawVal);
      if (validated.skip) continue;
      if (validated.clear) {
        if (field.secret) {
          if (nextOverrides[key] !== '') changedKeys.push(key + ':cleared');
          nextOverrides[key] = '';
        } else if (Object.prototype.hasOwnProperty.call(nextOverrides, key)) {
          delete nextOverrides[key];
          changedKeys.push(key + ':cleared');
        }
        continue;
      }
      nextOverrides[key] = validated.value;
      changedKeys.push(key);
    }
    const updatedAt = new Date(this.now()).toISOString();
    await this._persistOverrides(nextOverrides, updatedAt);
    this.overrides = nextOverrides;
    this.updatedAt = updatedAt;
    this._applyToRuntime();
    return { changedKeys, view: this.getSafeView() };
  }
}
