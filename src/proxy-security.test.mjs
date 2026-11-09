import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './server.mjs';
import { SessionStore } from './sessions.mjs';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(resolve));
}
function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('proxy Chatwoot autentica antes do forward, ignora Host externo e remove hop-by-hop headers', async () => {
  const forwarded = [];
  const upstream = http.createServer((req, res) => {
    forwarded.push({ path: req.url, host: req.headers.host, connection: req.headers.connection, privateHeader: req.headers['x-private-hop'] });
    res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive', 'x-upstream': 'ok' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const store = new SessionStore(path.join(os.tmpdir(), `proxy-${Date.now()}.json`));
  const app = await createApp({
    store,
    dashboardAuth: async req => req.headers.authorization === 'Bearer allowed',
    chatwootInternalUrl: `http://127.0.0.1:${upstreamPort}`
  });
  const server = http.createServer((req, res) => app(req, res));
  const port = await listen(server);
  try {
    // O upstream Chatwoot valida segredo/assinatura antes de aceitar este endpoint público.
    const webhook = await request(port, '/api/webhooks/whatsapp');
    assert.equal(webhook.status, 200);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].path, '/api/webhooks/whatsapp');

    const unknownWebhook = await request(port, '/api/webhooks/unknown');
    assert.equal(unknownWebhook.status, 401);
    assert.equal(forwarded.length, 1, 'paths de webhook fora da lista exata não devem ser encaminhados sem auth');

    const denied = await request(port, '/api/conversations', { host: 'attacker.invalid' });
    assert.equal(denied.status, 401);
    assert.equal(forwarded.length, 1, 'nenhum request operacional não autenticado deve chegar ao upstream');

    const allowed = await request(port, '/api/conversations', {
      authorization: 'Bearer allowed',
      host: 'attacker.invalid',
      connection: 'x-private-hop, keep-alive',
      'x-private-hop': 'must-not-forward'
    });
    assert.equal(allowed.status, 200);
    assert.equal(forwarded.length, 2);
    assert.equal(forwarded[1].path, '/api/conversations');
    assert.equal(forwarded[1].host, `127.0.0.1:${upstreamPort}`);
    assert.doesNotMatch(forwarded[1].connection || '', /x-private-hop/i);
    assert.equal(forwarded[1].privateHeader, undefined);

    const disallowedPrefix = await request(port, '/api/conversations-evil', { authorization: 'Bearer allowed' });
    assert.equal(disallowedPrefix.status, 404);
    assert.equal(forwarded.length, 2, 'prefixos fora do allowlist não devem ser encaminhados');
  } finally {
    await close(server);
    await close(upstream);
  }
});
