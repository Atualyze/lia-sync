import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { assertWebhookHostIsPublic, IntegrationsStore, isSafeWebhookUrl } from './http/integrations-store.mjs';
import { createApiV1Handler } from './http/api-v1.mjs';

function makeTmpFile() {
  return path.join(os.tmpdir(), `lia-integrations-${crypto.randomUUID()}.json`);
}

function makeReq(method, urlPath, { headers = {}, body = null } = {}) {
  const payload = body !== null ? JSON.stringify(body) : '';
  const stream = Readable.from(payload ? [Buffer.from(payload)] : []);
  stream.method = method;
  stream.url = urlPath;
  stream.headers = { 'content-type': 'application/json', ...headers };
  return stream;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(chunk = '') {
      this.body += chunk;
    }
  };
}

function makeMemoryStore() {
  const map = new Map();
  return {
    get(phone) { return map.get(phone) || null; },
    ensure(phone) {
      if (!map.has(phone)) map.set(phone, { history: [], meta: {} });
      return map.get(phone);
    },
    append(phone, msg) {
      const s = this.ensure(phone);
      s.history.push(msg);
    },
    all() {
      return [...map.entries()].map(([phone, data]) => ({ phone, ...data }));
    },
    markDirty() {},
    async flush() {},
    async refresh() {}
  };
}

test('IntegrationsStore: creates, verifies, lists without hash, and revokes API keys', async () => {
  const file = makeTmpFile();
  try {
    const store = new IntegrationsStore({ file, allowHttpLocal: false });
    const { key, plainKey } = await store.createApiKey({
      name: 'n8n Producao',
      scopes: ['read', 'write']
    });

    assert.ok(plainKey.startsWith('lia_live_'));
    assert.equal(key.name, 'n8n Producao');
    assert.deepEqual(key.scopes, ['read', 'write']);
    assert.equal(key.revokedAt, null);

    const listed = store.listApiKeys();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].hash, undefined);

    const verified = await store.verifyKey(plainKey);
    assert.ok(verified);
    assert.equal(verified.id, key.id);
    assert.deepEqual(verified.scopes, ['read', 'write']);

    const revoked = await store.revokeApiKey(key.id);
    assert.ok(revoked.revokedAt);

    const afterRevoke = await store.verifyKey(plainKey);
    assert.equal(afterRevoke, null);

    // Reload from disk to verify persistence
    const reloaded = new IntegrationsStore({ file, allowHttpLocal: false });
    assert.equal(await reloaded.verifyKey(plainKey), null);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('isSafeWebhookUrl & IntegrationsStore: blocks SSRF and private network URLs in production mode', async () => {
  assert.equal(isSafeWebhookUrl('https://n8n.example.com/webhook/abc', { allowHttpLocal: false }), true);
  assert.equal(isSafeWebhookUrl('http://n8n.example.com/webhook/abc', { allowHttpLocal: false }), false);
  assert.equal(isSafeWebhookUrl('https://localhost/hook', { allowHttpLocal: false }), false);
  assert.equal(isSafeWebhookUrl('https://127.0.0.1/hook', { allowHttpLocal: false }), false);
  assert.equal(isSafeWebhookUrl('https://10.0.0.5/hook', { allowHttpLocal: false }), false);
  assert.equal(isSafeWebhookUrl('https://192.168.1.10/hook', { allowHttpLocal: false }), false);
  assert.equal(isSafeWebhookUrl('https://172.16.0.2/hook', { allowHttpLocal: false }), false);
  assert.equal(isSafeWebhookUrl('https://169.254.169.254/latest/meta-data', { allowHttpLocal: false }), false);

  const file = makeTmpFile();
  try {
    const store = new IntegrationsStore({ file, allowHttpLocal: false });
    await assert.rejects(
      () => store.createWebhook({ name: 'Local SSRF', url: 'https://127.0.0.1/hook', events: ['message.received'] }),
      /invalid_webhook_url/
    );
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('IntegrationsStore: rejects mixed private DNS answers and pins the checked public address', async () => {
  const file = makeTmpFile();
  const publicAddress = { address: '93.184.216.34', family: 4 };
  let resolvedAddress = null;
  const requestImpl = (options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => {
      options.lookup(options.hostname, { family: 4 }, (error, address, family) => {
        assert.ifError(error);
        resolvedAddress = { address, family };
      });
      const response = new EventEmitter();
      response.statusCode = 202;
      response.resume = () => {};
      queueMicrotask(() => {
        onResponse(response);
        response.emit('end');
      });
    };
    return request;
  };

  try {
    const store = new IntegrationsStore({
      file,
      allowHttpLocal: false,
      dnsLookup: async () => [publicAddress],
      requestImpl
    });
    const hook = { url: 'https://hooks.example.com/path', secret: 'secret' };
    const result = await store._sendToWebhook(hook, 'webhook.test', {});
    assert.deepEqual(result, { ok: true, status: 202, error: null });
    assert.deepEqual(resolvedAddress, publicAddress);

    const unsafe = await assertWebhookHostIsPublic('https://hooks.example.com/path', {
      lookup: async () => [publicAddress, { address: '192.168.1.10', family: 4 }]
    });
    assert.deepEqual(unsafe, { ok: false, error: 'unsafe_webhook_host' });

    for (const address of ['::1', 'fc00::1', 'fe80::1', '2001:db8::1', '3fff::1', '192.0.2.1', '198.18.0.1']) {
      const family = address.includes(':') ? 6 : 4;
      const result = await assertWebhookHostIsPublic('https://hooks.example.com/path', {
        lookup: async () => [{ address, family }]
      });
      assert.deepEqual(result, { ok: false, error: 'unsafe_webhook_host' }, address);
    }

    const globalIpv6 = await assertWebhookHostIsPublic('https://hooks.example.com/path', {
      lookup: async () => [{ address: '2606:4700:4700::1111', family: 6 }]
    });
    assert.deepEqual(globalIpv6, { ok: true });

    const blockedStore = new IntegrationsStore({
      file,
      allowHttpLocal: false,
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
      requestImpl: () => assert.fail('must not send to a private DNS result')
    });
    const blocked = await blockedStore._sendToWebhook(
      { url: 'https://hooks.example.com/path', secret: 'secret' },
      'webhook.test',
      {}
    );
    assert.deepEqual(blocked, { ok: false, status: 0, error: 'unsafe_webhook_host' });
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('IntegrationsStore: signs outbound webhook payloads with HMAC-SHA256 and respects enabled toggle', async () => {
  const file = makeTmpFile();
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200 };
  };

  try {
    const store = new IntegrationsStore({ file, fetchImpl: fakeFetch, allowHttpLocal: false });
    const { webhook, secret } = await store.createWebhook({
      name: 'n8n Leads',
      url: 'https://hooks.example.com/lia',
      events: ['lead.updated']
    });
    assert.ok(secret.startsWith('whsec_'));

    const testResult = await store.testWebhook(webhook.id);
    assert.equal(testResult.ok, true);
    assert.equal(testResult.status, 200);
    assert.equal(requests.length, 1);

    const first = requests[0];
    assert.equal(first.init.headers['x-lia-event'], 'webhook.test');
    const expectedSig = crypto.createHmac('sha256', secret).update(first.init.body).digest('hex');
    assert.equal(first.init.headers['x-lia-signature'], `sha256=${expectedSig}`);

    await store.dispatchEvent('lead.updated', { phone: '5511999990000' });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].init.headers['x-lia-event'], 'lead.updated');

    // Unsubscribed event should not fire
    await store.dispatchEvent('message.received', { phone: '5511999990000' });
    assert.equal(requests.length, 2);

    // Disabled webhook should not fire
    await store.toggleWebhook(webhook.id, false);
    await store.dispatchEvent('lead.updated', { phone: '5511999990000' });
    assert.equal(requests.length, 2);

    const deleted = await store.deleteWebhook(webhook.id);
    assert.equal(deleted, true);
    assert.equal(store.listWebhooks().length, 0);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('api-v1 + IntegrationsStore: enforces API key scopes and dispatches lead.updated webhook', async () => {
  const file = makeTmpFile();
  const webhookCalls = [];
  const fakeFetch = async (url, init) => {
    webhookCalls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 202 };
  };

  try {
    const integrationsStore = new IntegrationsStore({ file, fetchImpl: fakeFetch, allowHttpLocal: false });
    const { plainKey: readOnlyKey } = await integrationsStore.createApiKey({
      name: 'Somente Leitura',
      scopes: ['read']
    });
    const { plainKey: writeKey } = await integrationsStore.createApiKey({
      name: 'CRM Escrita',
      scopes: ['read', 'write']
    });
    await integrationsStore.createWebhook({
      name: 'Webhook CRM',
      url: 'https://crm.example.com/hook',
      events: ['lead.updated']
    });

    const handler = createApiV1Handler({ integrationsStore });
    const memStore = makeMemoryStore();

    // Read-only key works on GET /api/v1/health
    const reqGet = makeReq('GET', '/api/v1/health', { headers: { authorization: `Bearer ${readOnlyKey}` } });
    const resGet = makeRes();
    await handler({ req: reqGet, res: resGet, u: new URL(reqGet.url, 'http://localhost'), store: memStore });
    assert.equal(resGet.statusCode, 200);

    // Read-only key is forbidden on POST /api/v1/leads
    const reqForbidden = makeReq('POST', '/api/v1/leads', {
      headers: { authorization: `Bearer ${readOnlyKey}` },
      body: { phone: '5511988887777', name: 'Marina' }
    });
    const resForbidden = makeRes();
    await handler({ req: reqForbidden, res: resForbidden, u: new URL(reqForbidden.url, 'http://localhost'), store: memStore });
    assert.equal(resForbidden.statusCode, 403);
    assert.equal(JSON.parse(resForbidden.body).error, 'insufficient_scope');

    // Write key succeeds on POST /api/v1/leads and fires lead.updated webhook
    const reqPost = makeReq('POST', '/api/v1/leads', {
      headers: { 'x-api-key': writeKey },
      body: { phone: '5511988887777', name: 'Marina', stage: 'qualificado' }
    });
    const resPost = makeRes();
    await handler({ req: reqPost, res: resPost, u: new URL(reqPost.url, 'http://localhost'), store: memStore });
    assert.equal(resPost.statusCode, 201);
    assert.equal(webhookCalls.length, 1);
    assert.equal(webhookCalls[0].body.event, 'lead.updated');
    assert.equal(webhookCalls[0].body.data.phone, '5511988887777');
  } finally {
    await fs.rm(file, { force: true });
  }
});
