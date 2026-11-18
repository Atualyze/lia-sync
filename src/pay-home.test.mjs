import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from './http/router.mjs';

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
  const router = createRouter({
    auth: async () => { authCalls += 1; return { ok: false, status: 401 }; }
  });

  const payResponse = responseCapture();
  await router({ method: 'GET', url: '/', headers: { host: 'pay.atualyze.com.br' } }, payResponse);
  assert.equal(payResponse.status, 200);
  assert.match(payResponse.headers['content-type'], /text\/html/);
  assert.match(payResponse.body, /portal público de pagamentos/i);
  assert.match(payResponse.body, /abra o link de pagamento/i);
  assert.equal(authCalls, 0);

  const otherResponse = responseCapture();
  await router({ method: 'GET', url: '/', headers: { host: 'chat.atualyze.com.br' } }, otherResponse);
  assert.equal(otherResponse.status, 401);
  assert.deepEqual(JSON.parse(otherResponse.body), { error: 'dashboard_auth_required' });
  assert.equal(authCalls, 1);
});
