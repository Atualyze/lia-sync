import test from 'node:test';
import assert from 'node:assert/strict';
import { stableIdlessEventKey, handleWebhookRoutes } from './webhook.mjs';
import { NOT_HANDLED } from './utils.mjs';

test('stableIdlessEventKey gera chave deterministica para eventos sem id', () => {
  const item = { jid: '5511999998888@s.whatsapp.net', eventTimestamp: 1700000000, text: 'oi' };
  const k1 = stableIdlessEventKey(item, 'messages.upsert');
  const k2 = stableIdlessEventKey(item, 'messages.upsert');
  assert.equal(k1, k2);
  assert.ok(k1.startsWith('fingerprint:'));
});

test('handleWebhookRoutes retorna NOT_HANDLED para rotas nao-webhook', async () => {
  const res = { writeHead() {}, end() {} };
  const result = await handleWebhookRoutes({
    req: { method: 'GET', url: '/health', headers: {} },
    res,
    u: new URL('http://localhost/health')
  });
  assert.equal(result, NOT_HANDLED);
});

test('handleWebhookRoutes retorna 401 quando webhookAuthorize rejeita', async () => {
  let statusCode = 0;
  let body = '';
  const res = {
    writeHead(code) { statusCode = code; },
    end(chunk) { body = String(chunk || ''); }
  };
  await handleWebhookRoutes({
    req: { method: 'POST', url: '/webhook/evolution', headers: {} },
    res,
    u: new URL('http://localhost/webhook/evolution'),
    webhookAuthorize: () => false
  });
  assert.equal(statusCode, 401);
  assert.ok(body.includes('unauthorized') || body.length > 0);
});

test('handleWebhookRoutes retorna 401 quando webhookAuthorize retorna { ok: false }', async () => {
  let statusCode = 0;
  let body = '';
  const res = {
    writeHead(code) { statusCode = code; },
    end(chunk) { body = String(chunk || ''); }
  };
  await handleWebhookRoutes({
    req: { method: 'POST', url: '/webhook/evolution', headers: {} },
    res,
    u: new URL('http://localhost/webhook/evolution'),
    webhookAuthorize: () => ({ ok: false })
  });
  assert.equal(statusCode, 401);
  assert.ok(body.includes('unauthorized'));
});
