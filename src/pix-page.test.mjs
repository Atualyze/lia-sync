import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPixPaymentPage } from './http/pix-page.mjs';
import { buildPixPayload } from './tools/gerar_cobranca_pix.mjs';

function responseCapture() {
  return {
    headers: null,
    status: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = String(body || ''); }
  };
}

test('portal Pix renderiza QR, cópia da chave, copia e cola e checkout InfinitePay', async () => {
  const payload = buildPixPayload({ pixKey: '88998340085', amount: 20, merchantName: 'Atualyze', merchantCity: 'SOBRAL', description: 'Racao' });
  const url = new URL(`https://pay.atualyze.com.br/pix?p=${Buffer.from(payload).toString('base64url')}&v=20&n=Atualyze&d=Racao&tx=LIA123&c=${encodeURIComponent('https://checkout.infinitepay.io/atualyze/abc')}`);
  const res = responseCapture();
  await renderPixPaymentPage(res, url);
  assert.equal(res.status, 200);
  assert.match(res.body, /Copiar c\u00f3digo Pix/);
  assert.match(res.body, /Copiar chave Pix/);
  assert.match(res.body, /Pagar com InfinitePay/);
  assert.match(res.body, /checkout\.infinitepay\.io/);
  assert.match(res.body, /Atualyze/);
  assert.match(res.body, /R\$ 20,00/);
});

test('portal rejeita payload ausente com mensagem clara', async () => {
  const res = responseCapture();
  await renderPixPaymentPage(res, new URL('https://pay.atualyze.com.br/pix'));
  assert.equal(res.status, 400);
  assert.match(res.body, /Link Pix inv\u00e1lido/);
});
