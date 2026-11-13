import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from './sessions.mjs';
import { createApp } from './server.mjs';

test('health é liveness compatível e ready traduz indisponibilidade em 503', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `readiness-${Date.now()}.json`));
  const app = await createApp({ store, dashboardAuth: async () => true, readinessCheck: async () => ({ ok: false, status: 'not_ready', checks: [{ name: 'ai', status: 'unavailable' }] }) });
  const server = http.createServer((req, res) => app(req, res));
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).status, 'not_ready');
  await new Promise(resolve => server.close(resolve));
});
