import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from './http/router.mjs';
import { buildPixPayload } from './tools/gerenciar_cobranca_pagamento.mjs';

function responseCapture() {
  return {
    headers: null,
    status: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = String(body || ''); }
  };
}

test('raiz do Atualyze Pay é pública sem abrir os outros dashboards', async () => {
  let authCalls = 0;
  const adminConfig = {
    active: {
      identity: { botName: 'Lia', companyName: 'Atualyze' },
      tools: { settings: { gerenciar_cobranca_pagamento: {
        key: 'pix-root@atualyze.com.br',
        keyType: 'email',
        merchantName: 'Atualyze',
        merchantCity: 'SOBRAL'
      } } }
    }
  };
  const router = createRouter({
    adminConfig,
    auth: async () => { authCalls += 1; return { ok: false, status: 401 }; }
  });

  const payResponse = responseCapture();
  await router({ method: 'GET', url: '/', headers: { host: 'pay.atualyze.com.br' } }, payResponse);
  assert.equal(payResponse.status, 200);
  assert.match(payResponse.headers['content-type'], /text\/html/);
  assert.match(payResponse.body, /Portal de pagamentos/);
  assert.match(payResponse.body, /Pagamentos simples, em um s\u00f3 lugar/);
  assert.doesNotMatch(payResponse.body, /pix-root@atualyze\.com\.br/);
  assert.doesNotMatch(payResponse.body, /QR Code Pix para pagamento/);
  assert.equal(authCalls, 0);

  const otherResponse = responseCapture();
  await router({ method: 'GET', url: '/', headers: { host: 'chat.atualyze.com.br' } }, otherResponse);
  assert.equal(otherResponse.status, 401);
  assert.deepEqual(JSON.parse(otherResponse.body), { error: 'dashboard_auth_required' });
  assert.equal(authCalls, 1);
});


test('link Pix curto renderiza a cobrança no próprio caminho /p/:code', async () => {
  const shortCode = 'AbCdEf0123456789';
  const payload = buildPixPayload({
    pixKey: '88998340085',
    amount: 30,
    merchantName: 'Atualyze',
    merchantCity: 'SOBRAL',
    txid: 'LIA123',
    description: 'Pagamento'
  });
  const storedPaymentUrl = `https://pay.atualyze.com.br/pix?p=${Buffer.from(payload).toString('base64url')}&v=30.00&n=Atualyze&tx=LIA123`;
  const store = {
    paymentOrderStore: {
      async findByShortCode(code) {
        assert.equal(code, shortCode);
        return { orderNsu: 'LIA123', paymentUrl: storedPaymentUrl };
      }
    }
  };
  const router = createRouter({
    store,
    adminConfig: { active: { tools: { settings: { gerenciar_cobranca_pagamento: {} } } } },
    auth: async () => { throw new Error('link Pix público não deve exigir autenticação'); }
  });
  const response = responseCapture();
  await router({ method: 'GET', url: `/p/${shortCode}`, headers: { host: 'pay.atualyze.com.br' } }, response);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\\/html/);
  assert.match(response.body, /R\\$ 30,00/);
  assert.match(response.body, /Atualyze/);
  assert.equal(response.headers.location, undefined);
});

test('link Pix curto inexistente retorna página indisponível sem redirecionar', async () => {
  const router = createRouter({
    store: { paymentOrderStore: { async findByShortCode() { return null; } } },
    adminConfig: { active: { tools: { settings: { gerenciar_cobranca_pagamento: {} } } } },
    auth: async () => { throw new Error('link Pix público não deve exigir autenticação'); }
  });
  const response = responseCapture();
  await router({ method: 'GET', url: '/p/AbCdEf0123456789', headers: { host: 'pay.atualyze.com.br' } }, response);
  assert.equal(response.status, 404);
  assert.match(response.body, /Link Pix indisponível/);
});
