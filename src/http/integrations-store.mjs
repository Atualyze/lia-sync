import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const VALID_SCOPES = new Set(['read', 'write', 'ai']);
const VALID_EVENTS = new Set(['message.received', 'handoff.triggered', 'lead.updated', 'webhook.test']);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function timingSafeHexMatch(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function isSafeWebhookUrl(rawUrl, { allowHttpLocal = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    return false;
  }
  const proto = parsed.protocol.toLowerCase();
  if (proto !== 'https:' && !(allowHttpLocal && proto === 'http:')) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (!allowHttpLocal) {
    if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  }
  return true;
}

/**
 * Armazena Chaves de API e Webhooks de Saída no Supabase (`runtime_projections`)
 * com fallback local apenas quando o Supabase não está habilitado.
 */
export class IntegrationsStore {
  constructor({ client = null, file = path.resolve('./data/api-integrations.json'), fetchImpl = fetch, allowHttpLocal = process.env.NODE_ENV !== 'production' } = {}) {
    this.client = client;
    this.file = file;
    this.fetchImpl = fetchImpl;
    this.allowHttpLocal = allowHttpLocal;
    this.apiKeys = [];
    this.webhooks = [];
    this._loaded = false;
    this._flushQueue = Promise.resolve();
  }

  async load() {
    if (this._loaded) return;
    if (this.client?.enabled) {
      try {
        const rows = await this.client.select('runtime_projections', 'select=payload&key=eq.api_integrations&limit=1');
        const payload = rows?.[0]?.payload;
        if (payload && typeof payload === 'object') {
          this.apiKeys = Array.isArray(payload.apiKeys) ? payload.apiKeys : [];
          this.webhooks = Array.isArray(payload.webhooks) ? payload.webhooks : [];
        }
        this._loaded = true;
        return;
      } catch {}
    }
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.apiKeys = Array.isArray(parsed?.apiKeys) ? parsed.apiKeys : [];
      this.webhooks = Array.isArray(parsed?.webhooks) ? parsed.webhooks : [];
    } catch {}
    this._loaded = true;
  }

  async flush() {
    this._flushQueue = this._flushQueue.then(async () => {
      const payload = { apiKeys: this.apiKeys, webhooks: this.webhooks };
      if (this.client?.enabled) {
        await this.client.upsert('runtime_projections', [{
          key: 'api_integrations',
          payload,
          updated_at: new Date().toISOString()
        }], 'key');
        return;
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
      await fs.rename(tmp, this.file);
    });
    return this._flushQueue;
  }

  listApiKeys() {
    return this.apiKeys.map(({ hash, ...rest }) => rest);
  }

  async createApiKey({ name, scopes = ['read', 'write', 'ai'] } = {}) {
    await this.load();
    const cleanName = String(name || '').trim().slice(0, 80);
    if (!cleanName) throw new Error('invalid_key_name');
    const cleanScopes = Array.isArray(scopes) ? scopes.map(s => String(s).trim()).filter(s => VALID_SCOPES.has(s)) : ['read', 'write', 'ai'];
    const finalScopes = cleanScopes.length ? [...new Set(cleanScopes)] : ['read', 'write', 'ai'];
    const plainKey = `lia_live_${crypto.randomBytes(24).toString('hex')}`;
    const record = {
      id: crypto.randomUUID(),
      name: cleanName,
      prefix: `${plainKey.slice(0, 14)}…${plainKey.slice(-4)}`,
      hash: sha256Hex(plainKey),
      scopes: finalScopes,
      createdAt: new Date().toISOString(),
      revokedAt: null,
      lastUsedAt: null
    };
    this.apiKeys.unshift(record);
    await this.flush();
    const { hash, ...safeRecord } = record;
    return { key: safeRecord, plainKey };
  }

  async revokeApiKey(id) {
    await this.load();
    const target = this.apiKeys.find(item => item.id === id);
    if (!target) return null;
    if (!target.revokedAt) {
      target.revokedAt = new Date().toISOString();
      await this.flush();
    }
    const { hash, ...safeRecord } = target;
    return safeRecord;
  }

  async verifyKey(plainKey) {
    if (!plainKey || typeof plainKey !== 'string') return null;
    await this.load();
    const candidateHash = sha256Hex(plainKey.trim());
    let matched = null;
    for (const item of this.apiKeys) {
      if (!item.revokedAt && timingSafeHexMatch(candidateHash, item.hash)) {
        matched = item;
      }
    }
    if (!matched) return null;
    matched.lastUsedAt = new Date().toISOString();
    void this.flush().catch(() => {});
    return { id: matched.id, name: matched.name, scopes: matched.scopes || ['read', 'write', 'ai'] };
  }

  listWebhooks() {
    return this.webhooks.map(({ secret, ...rest }) => rest);
  }

  async createWebhook({ name, url, events = ['message.received', 'handoff.triggered', 'lead.updated'] } = {}) {
    await this.load();
    const cleanName = String(name || '').trim().slice(0, 80);
    const cleanUrl = String(url || '').trim();
    if (!cleanName) throw new Error('invalid_webhook_name');
    if (!isSafeWebhookUrl(cleanUrl, { allowHttpLocal: this.allowHttpLocal })) {
      throw new Error('invalid_webhook_url');
    }
    const cleanEvents = Array.isArray(events)
      ? events.map(e => String(e).trim()).filter(e => VALID_EVENTS.has(e))
      : [];
    if (!cleanEvents.length) throw new Error('invalid_webhook_events');
    const secret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
    const record = {
      id: crypto.randomUUID(),
      name: cleanName,
      url: cleanUrl,
      events: [...new Set(cleanEvents)],
      secret,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastTriggeredAt: null,
      lastStatus: null,
      lastError: null
    };
    this.webhooks.unshift(record);
    await this.flush();
    const { secret: _, ...safeRecord } = record;
    return { webhook: safeRecord, secret };
  }

  async toggleWebhook(id, enabled) {
    await this.load();
    const target = this.webhooks.find(item => item.id === id);
    if (!target) return null;
    target.enabled = Boolean(enabled);
    await this.flush();
    const { secret, ...safeRecord } = target;
    return safeRecord;
  }

  async deleteWebhook(id) {
    await this.load();
    const idx = this.webhooks.findIndex(item => item.id === id);
    if (idx === -1) return false;
    this.webhooks.splice(idx, 1);
    await this.flush();
    return true;
  }

  async _sendToWebhook(hook, eventType, data) {
    const payload = JSON.stringify({
      event: eventType,
      timestamp: new Date().toISOString(),
      data
    });
    const sig = crypto.createHmac('sha256', hook.secret || '').update(payload).digest('hex');
    hook.lastTriggeredAt = new Date().toISOString();
    try {
      const response = await this.fetchImpl(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lia-event': eventType,
          'x-lia-signature': `sha256=${sig}`
        },
        body: payload,
        signal: AbortSignal.timeout(5000)
      });
      hook.lastStatus = response.status;
      hook.lastError = response.ok ? null : `HTTP ${response.status}`;
      return { ok: response.ok, status: response.status, error: hook.lastError };
    } catch (err) {
      hook.lastStatus = 0;
      hook.lastError = err?.message || 'request_failed';
      return { ok: false, status: 0, error: hook.lastError };
    }
  }

  async testWebhook(id) {
    await this.load();
    const hook = this.webhooks.find(item => item.id === id);
    if (!hook) return null;
    const result = await this._sendToWebhook(hook, 'webhook.test', {
      message: 'Teste de webhook disparado pelo painel Lia Sync.'
    });
    await this.flush().catch(() => {});
    return result;
  }

  async dispatchEvent(eventType, data) {
    await this.load();
    const targets = this.webhooks.filter(h => h.enabled && Array.isArray(h.events) && h.events.includes(eventType));
    if (!targets.length) return [];
    const results = await Promise.allSettled(targets.map(hook => this._sendToWebhook(hook, eventType, data)));
    void this.flush().catch(() => {});
    return results;
  }
}
