import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
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
 * Proteção contra DNS rebinding: resolve o hostname do webhook e rejeita se
 * algum endereço retornado cair em faixa privada/loopback/link-local. Falha
 * fechada quando a resolução não responde. Usada no envio (não só no cadastro),
 * porque o DNS pode apontar para outro alvo entre o cadastro e o disparo.
 */
function ipv4ToNumber(ip) {
  if (isIP(ip) !== 4) return null;
  return ip.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}

const NON_PUBLIC_IPV4_RANGES = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([address, prefix]) => ({
  network: ipv4ToNumber(address),
  size: 2 ** (32 - prefix)
}));

function expandIpv6(ip) {
  let value = ip.toLowerCase();
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = ipv4ToNumber(value.slice(lastColon + 1));
    if (ipv4 === null) return null;
    value = `${value.slice(0, lastColon)}:${Math.floor(ipv4 / 65536).toString(16)}:${(ipv4 % 65536).toString(16)}`;
  }
  const sides = value.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((sides.length === 1 && missing !== 0) || (sides.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map(group => Number.parseInt(group || '0', 16));
  return groups.length === 8 && groups.every(Number.isFinite) ? groups : null;
}

function isPrivateAddressIp(ip) {
  const family = isIP(ip);
  if (family === 4) {
    const value = ipv4ToNumber(ip);
    return NON_PUBLIC_IPV4_RANGES.some(({ network, size }) =>
      Math.floor(value / size) === Math.floor(network / size)
    );
  }
  if (family !== 6) return true;

  const groups = expandIpv6(ip);
  if (!groups) return true;
  const isIpv4Mapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
  if (isIpv4Mapped) return true;

  const first = groups[0];
  if (first < 0x2000 || first > 0x3fff) return true;
  if (first === 0x2001 && (groups[1] <= 0x01ff || groups[1] === 0x0db8)) return true;
  if (first === 0x2002 || (first === 0x3fff && groups[1] <= 0x000f)) return true;
  return false;
}

async function resolvePublicWebhookHost(rawUrl, lookup = dns.lookup) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.protocol.toLowerCase() !== 'https:') return { ok: false, error: 'unsafe_webhook_protocol' };
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, error: 'invalid_url' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: 'unsafe_webhook_host' };
  }
  const family = isIP(host);
  if (family) {
    if (isPrivateAddressIp(host)) return { ok: false, error: 'unsafe_webhook_host' };
    return { ok: true, addresses: [{ address: host, family }] };
  }
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch (err) {
    return { ok: false, error: err?.code === 'ENOTFOUND' ? 'dns_resolution_failed' : 'dns_check_failed' };
  }
  if (!records?.length) return { ok: false, error: 'dns_resolution_failed' };
  if (records.some(record => !record || typeof record.address !== 'string' || isPrivateAddressIp(record.address))) {
    return { ok: false, error: 'unsafe_webhook_host' };
  }
  return { ok: true, addresses: records };
}

export async function assertWebhookHostIsPublic(rawUrl, { lookup = dns.lookup } = {}) {
  const result = await resolvePublicWebhookHost(rawUrl, lookup);
  return result.ok ? { ok: true } : result;
}

export function createPinnedWebhookLookup(addresses) {
  const pinned = Array.isArray(addresses)
    ? addresses.filter(item => item && typeof item.address === 'string' && isIP(item.address) === item.family)
    : [];
  return (_hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const matching = options?.family
      ? pinned.filter(item => item.family === options.family)
      : pinned;
    if (options?.all) {
      callback(null, matching);
      return;
    }
    const record = matching[0];
    if (!record) {
      const error = Object.assign(new Error('No pinned public address'), { code: 'ENOTFOUND' });
      callback(error);
      return;
    }
    callback(null, record.address, record.family);
  };
}

function requestPinnedWebhook(url, options, addresses, requestImpl = null) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const transport = parsed.protocol === 'https:' ? https : http;
  const makeRequest = requestImpl || transport.request.bind(transport);

  return new Promise((resolve, reject) => {
    const request = makeRequest({
      protocol: parsed.protocol,
      hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      lookup: createPinnedWebhookLookup(addresses)
    }, response => {
      response.once('end', () => {
        const status = Number(response.statusCode || 0);
        resolve({ status, ok: status >= 200 && status < 300 });
      });
      response.once('error', reject);
      response.resume();
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

/**
 * Armazena Chaves de API e Webhooks de Saída no Supabase (`runtime_projections`).
 * Com Supabase habilitado não há fallback silencioso para arquivo local: se a
 * leitura remota falhar, a store fica indisponível e `verifyKey` falha fechado.
 * O fallback local existe apenas quando o Supabase não está habilitado.
 */
export class IntegrationsStore {
  constructor({ client = null, file = path.resolve('./data/api-integrations.json'), fetchImpl = fetch, allowHttpLocal = process.env.NODE_ENV !== 'production', revalidateMs = 30000, dnsLookup = dns.lookup, requestImpl = null } = {}) {
    this.client = client;
    this.file = file;
    this.fetchImpl = fetchImpl;
    this.allowHttpLocal = allowHttpLocal;
    this.dnsLookup = dnsLookup;
    this.requestImpl = requestImpl;
    this.revalidateMs = Number.isFinite(Number(revalidateMs)) && Number(revalidateMs) >= 0 ? Number(revalidateMs) : 30000;
    this.apiKeys = [];
    this.webhooks = [];
    this.remoteError = null;
    this._loaded = false;
    this._loadedAt = 0;
    this._loading = null;
    this._flushQueue = Promise.resolve();
  }

  get available() {
    return !this.client?.enabled || !this.remoteError;
  }

  async load() {
    if (this.client?.enabled) {
      // Cache curto: releitura remota no máximo a cada `revalidateMs`, para que
      // revogação feita em outra réplica propague sem exigir restart.
      if (this._loaded && Date.now() - this._loadedAt < this.revalidateMs) return;
      await this._loadRemote();
      return;
    }
    if (this._loaded) return;
    await this._loadLocal();
  }

  async _loadRemote() {
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try {
        const rows = await this.client.select('runtime_projections', 'select=payload&key=eq.api_integrations&limit=1');
        const payload = rows?.[0]?.payload;
        this.apiKeys = Array.isArray(payload?.apiKeys) ? payload.apiKeys : [];
        this.webhooks = Array.isArray(payload?.webhooks) ? payload.webhooks : [];
        this.remoteError = null;
      } catch (error) {
        // Sem fallback local: o estado em memória é limpo e a store fica
        // indisponível, de modo que nenhuma chave antiga continue válida.
        this.remoteError = error?.code || error?.name || 'integrations_store_unavailable';
        this.apiKeys = [];
        this.webhooks = [];
      } finally {
        this._loaded = true;
        this._loadedAt = Date.now();
        this._loading = null;
      }
    })();
    return this._loading;
  }

  async _loadLocal() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.apiKeys = Array.isArray(parsed?.apiKeys) ? parsed.apiKeys : [];
      this.webhooks = Array.isArray(parsed?.webhooks) ? parsed.webhooks : [];
      this.remoteError = null;
    } catch {
      this.apiKeys = [];
      this.webhooks = [];
    }
    this._loaded = true;
    this._loadedAt = Date.now();
  }

  async flush() {
    // A fila não é envenenada por uma falha anterior: cada gravação propaga o
    // seu próprio erro ao chamador sem impedir tentativas seguintes.
    const run = this._flushQueue.catch(() => {}).then(async () => {
      const payload = { apiKeys: this.apiKeys, webhooks: this.webhooks };
      if (this.client?.enabled) {
        await this.client.upsert('runtime_projections', [{
          key: 'api_integrations',
          payload,
          updated_at: new Date().toISOString()
        }], 'key');
        this.remoteError = null;
        return;
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
      await fs.rename(tmp, this.file);
    });
    this._flushQueue = run.catch(() => {});
    return run;
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
    // Supabase habilitado e leitura indisponível: nega toda chave (fail closed)
    // em vez de aceitar o estado em memória ou um arquivo local desatualizado.
    if (this.client?.enabled && this.remoteError) return null;
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
      const requestOptions = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lia-event': eventType,
          'x-lia-signature': `sha256=${sig}`
        },
        body: payload,
        signal: AbortSignal.timeout(5000)
      };
      let response;
      if (this.fetchImpl === fetch && !this.allowHttpLocal) {
        const hostCheck = await resolvePublicWebhookHost(hook.url, this.dnsLookup);
        if (!hostCheck.ok) {
          hook.lastStatus = 0;
          hook.lastError = hostCheck.error;
          return { ok: false, status: 0, error: hostCheck.error };
        }
        response = await requestPinnedWebhook(hook.url, requestOptions, hostCheck.addresses, this.requestImpl);
      } else {
        response = await this.fetchImpl(hook.url, requestOptions);
      }
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
