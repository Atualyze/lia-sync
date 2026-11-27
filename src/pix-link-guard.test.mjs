import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from './http/router.mjs';
import { createPublicRateLimiter } from './http/public-rate-limit.mjs';
import { buildPixPayload } from './tools/gerenciar_cobranca_pagamento.mjs';

function responseCapture() {
  return {
    headers: null, status: null, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = String(body || ''); }
  };
}

const payloadFor = (pixKey) => buildPixPayload({ pixKey, amount: 30, merchantName: 'Atualyze', merchantCity: 'SOBRAL', txid: 'LIA123', description: 'Pagamento' });
const linkFor = (payload, tx = 'LIA123') => `https://pay.atualyze.com.br/pix?p=${Buffer.from(payload).toString('base64url')}&v=30.00&n=Atualyze&tx=${tx}`;

function routerWith(orders) {
  return createRouter({
    store: { paymentOrderStore: { async getOrder(nsu) { return orders[nsu] || null; } } },
    adminConfig: { active: { tools: { settings: { gerenciar_cobranca_pagamento: {} } } } },
    auth: async () => { throw new Error('rota pública não deve exigir autenticação'); }
  });
}

test('/pix renderiza apenas payloads emitidos pelo sistema', async () => {
  const issued = linkFor(payloadFor('88998340085'));
  const router = routerWith({ LIA123: { orderNsu: 'LIA123', paymentUrl: issued } });
  const url = new URL(issued);
  const ok = responseCapture();
  await router({ method: 'GET', url: url.pathname + url.search, headers: { host: 'pay.atualyze.com.br' } }, ok);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /R\$ 30,00/);
});

test('/pix rejeita payload forjado com outra chave, mesmo reutilizando um tx válido', async () => {
  const issued = linkFor(payloadFor('88998340085'));
  const router = routerWith({ LIA123: { orderNsu: 'LIA123', paymentUrl: issued } });
  const forged = new URL(linkFor(payloadFor('99999999999')));
  const res = responseCapture();
  await router({ method: 'GET', url: forged.pathname + forged.search, headers: { host: 'pay.atualyze.com.br' } }, res);
  assert.equal(res.status, 404);
  assert.match(res.body, /Link Pix indisponível/);
  assert.doesNotMatch(res.body, /99999999999/);
});

test('/pix rejeita tx inexistente e link sem tx', async () => {
  const router = routerWith({});
  for (const link of [linkFor(payloadFor('88998340085'), 'NOPE'), linkFor(payloadFor('88998340085'), '')]) {
    const u = new URL(link);
    const res = responseCapture();
    await router({ method: 'GET', url: u.pathname + u.search, headers: { host: 'pay.atualyze.com.br' } }, res);
    assert.equal(res.status, 404);
  }
});

test('limitador público responde 429 após o limite e libera na janela seguinte', () => {
  let t = 0;
  const check = createPublicRateLimiter({ limitPerMin: 2, now: () => t });
  assert.equal(check('ip').allowed, true);
  assert.equal(check('ip').allowed, true);
  const blocked = check('ip');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.equal(check('outro').allowed, true);
  t = 61_000;
  assert.equal(check('ip').allowed, true);
});

test('rotas públicas de pagamento retornam 429 acima do limite', async () => {
  process.env.PAY_PUBLIC_RATE_LIMIT_PER_MIN = '2';
  try {
    const router = routerWith({});
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const res = responseCapture();
      await router({ method: 'GET', url: '/pix', headers: { host: 'pay.atualyze.com.br', 'x-forwarded-for': '203.0.113.9' } }, res);
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [404, 404, 429]);
  } finally {
    delete process.env.PAY_PUBLIC_RATE_LIMIT_PER_MIN;
  }
});

test('raiz do portal usa o host de paymentBaseUrl configurado', async () => {
  const router = createRouter({
    adminConfig: { active: { tools: { settings: { gerenciar_cobranca_pagamento: { paymentBaseUrl: 'https://pagar.exemplo.com.br' } } } } },
    auth: async () => ({ ok: false, status: 401 })
  });
  const res = responseCapture();
  await router({ method: 'GET', url: '/', headers: { host: 'pagar.exemplo.com.br' } }, res);
  assert.equal(res.status, 200);
  assert.match(res.body, /Portal de pagamentos/);
});
