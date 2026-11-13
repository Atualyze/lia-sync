import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlIdempotencyStore } from './core/idempotency.mjs';
import { handleBridgeRoutes } from './http/bridge-routes.mjs';

function response() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = body; }
  };
}

function request({ method = 'POST', body = '{}' } = {}) {
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); }
  };
}

test('idempotência por ação respeita TTL e não duplica resultado', () => {
  let now = 1000;
  const store = new TtlIdempotencyStore({ now: () => now, ttlMs: 100, max: 10 });
  assert.deepEqual(store.claim('send:1', { ok: true }), { duplicate: false, value: { ok: true } });
  assert.deepEqual(store.claim('send:1', { ok: false }), { duplicate: true, value: { ok: true } });
  now += 101;
  assert.deepEqual(store.claim('send:1', { ok: false }), { duplicate: false, value: { ok: false } });
});

test('bridge usa contrato consistente e não expõe detalhes em JSON inválido', async () => {
  const res = response();
  await handleBridgeRoutes({
    req: request({ body: '{invalid' }),
    res,
    u: new URL('http://localhost/api/bridge/send'),
    store: { sessions: {} },
    f: {},
    webhookAuthorize: async () => true
  });
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'invalid_json' });
});

test('bridge falha fechado sem autenticação e mantém {ok:false}', async () => {
  const res = response();
  await handleBridgeRoutes({
    req: request(),
    res,
    u: new URL('http://localhost/api/bridge/message'),
    store: { sessions: {} },
    f: {},
    webhookAuthorize: async () => false
  });
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'unauthorized' });
});
