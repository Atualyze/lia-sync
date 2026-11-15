import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApiV1Handler } from './http/api-v1.mjs';

function makeReq(method, urlPath, { headers = {}, body = null } = {}) {
  const payload = body !== null ? JSON.stringify(body) : '';
  const stream = Readable.from(payload ? [Buffer.from(payload)] : []);
  stream.method = method;
  stream.url = urlPath;
  stream.headers = { 'content-type': 'application/json', ...headers };
  return stream;
}

function makeRes() {
  const res = {
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
  return res;
}

function makeMemoryStore() {
  const map = new Map();
  return {
    get(phone) { return map.get(phone) || null; },
    ensure(phone) {
      if (!map.has(phone)) map.set(phone, { history: [] });
      return map.get(phone);
    },
    append(phone, msg) {
      const s = this.ensure(phone);
      s.history.push(msg);
    },
    markDirty() {},
    async flush() {},
    async refresh() {}
  };
}

test('api-v1: fails closed with 503 when no API key is configured', async () => {
  const handler = createApiV1Handler({ apiKeys: [] });
  const req = makeReq('GET', '/api/v1/health');
  const res = makeRes();
  await handler({ req, res, u: new URL(req.url, 'http://localhost'), store: makeMemoryStore() });
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error, 'api_v1_not_configured');
});

test('api-v1: rejects missing or invalid API key with 401', async () => {
  const handler = createApiV1Handler({ apiKeys: ['secret-key-123'] });
  const req = makeReq('GET', '/api/v1/health', { headers: { 'x-api-key': 'wrong-key' } });
  const res = makeRes();
  await handler({ req, res, u: new URL(req.url, 'http://localhost'), store: makeMemoryStore() });
  assert.equal(res.statusCode, 401);
});

test('api-v1: serves health and openapi.json with valid Bearer token', async () => {
  const handler = createApiV1Handler({ apiKeys: ['secret-key-123'] });
  const reqHealth = makeReq('GET', '/api/v1/health', { headers: { authorization: 'Bearer secret-key-123' } });
  const resHealth = makeRes();
  await handler({
    req: reqHealth,
    res: resHealth,
    u: new URL(reqHealth.url, 'http://localhost'),
    store: makeMemoryStore(),
    readinessCheck: async () => ({ ok: true, checks: [{ name: 'supabase', status: 'ready' }] })
  });
  assert.equal(resHealth.statusCode, 200);
  assert.equal(JSON.parse(resHealth.body).ready, true);

  const reqSpec = makeReq('GET', '/api/v1/openapi.json', { headers: { 'x-api-key': 'secret-key-123' } });
  const resSpec = makeRes();
  await handler({ req: reqSpec, res: resSpec, u: new URL(reqSpec.url, 'http://localhost'), store: makeMemoryStore() });
  assert.equal(resSpec.statusCode, 200);
  assert.equal(JSON.parse(resSpec.body).openapi, '3.0.3');
});

test('api-v1: creates lead, updates contact, and sends WhatsApp message respecting suppression', async () => {
  const sent = [];
  const store = makeMemoryStore();
  const handler = createApiV1Handler({
    apiKeys: ['secret-key-123'],
    sendMessage: async (phone, msg) => {
      if (phone.endsWith('9999')) throw new Error('contact_suppressed');
      sent.push({ phone, msg });
      return { key: { id: 'msg-1' } };
    }
  });

  const leadReq = makeReq('POST', '/api/v1/leads', {
    headers: { 'x-api-key': 'secret-key-123' },
    body: { phone: '5511999991111', name: 'Maria', interest: 'Plano Pro', source: 'Site', sendGreeting: true }
  });
  const leadRes = makeRes();
  await handler({ req: leadReq, res: leadRes, u: new URL(leadReq.url, 'http://localhost'), store });
  assert.equal(leadRes.statusCode, 201);
  assert.equal(JSON.parse(leadRes.body).sent, true);
  assert.equal(sent.length, 1);

  const patchReq = makeReq('PATCH', '/api/v1/contacts/5511999991111', {
    headers: { 'x-api-key': 'secret-key-123' },
    body: { dealStage: 'qualificado', notes: 'Pediu proposta' }
  });
  const patchRes = makeRes();
  await handler({ req: patchReq, res: patchRes, u: new URL(patchReq.url, 'http://localhost'), store });
  assert.equal(patchRes.statusCode, 200);
  assert.equal(JSON.parse(patchRes.body).contact.dealStage, 'qualificado');

  const supReq = makeReq('POST', '/api/v1/messages/send', {
    headers: { 'x-api-key': 'secret-key-123' },
    body: { phone: '5511999999999', message: 'Oi' }
  });
  const supRes = makeRes();
  await handler({ req: supReq, res: supRes, u: new URL(supReq.url, 'http://localhost'), store });
  assert.equal(supRes.statusCode, 409);
  assert.equal(JSON.parse(supRes.body).error, 'contact_suppressed');
});

test('api-v1: executes /ai/ask and enforces per-key rate limit', async () => {
  const handler = createApiV1Handler({
    apiKeys: ['secret-key-123'],
    rateLimitPerMin: 2,
    askAIImpl: async ({ userText }) => ({ text: `Echo: ${userText}`, provider: 'cloudflare', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' })
  });

  const askReq = makeReq('POST', '/api/v1/ai/ask', {
    headers: { 'x-api-key': 'secret-key-123' },
    body: { prompt: 'Qual o horário?' }
  });
  const askRes = makeRes();
  await handler({
    req: askReq,
    res: askRes,
    u: new URL(askReq.url, 'http://localhost'),
    store: makeMemoryStore(),
    adminConfig: { active: { identity: { systemPrompt: 'Seja breve.' } } },
    runtimeAI: () => ({ provider: 'cloudflare', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', fallbackModels: [] })
  });
  assert.equal(askRes.statusCode, 200);
  assert.equal(JSON.parse(askRes.body).reply, 'Echo: Qual o horário?');

  const r2 = makeRes();
  await handler({ req: makeReq('GET', '/api/v1/health', { headers: { 'x-api-key': 'secret-key-123' } }), res: r2, u: new URL('/api/v1/health', 'http://localhost'), store: makeMemoryStore() });
  assert.equal(r2.statusCode, 200);

  const r3 = makeRes();
  await handler({ req: makeReq('GET', '/api/v1/health', { headers: { 'x-api-key': 'secret-key-123' } }), res: r3, u: new URL('/api/v1/health', 'http://localhost'), store: makeMemoryStore() });
  assert.equal(r3.statusCode, 429);
});
