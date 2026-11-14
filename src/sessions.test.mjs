import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, normalizePhone, mask } from './sessions.mjs';

test('normalizePhone e mask formatam numeros brasileiros corretamente', () => {
  assert.equal(normalizePhone('+55 (11) 99999-8888'), '5511999998888');
  assert.equal(normalizePhone('sim:5511999998888'), 'sim:5511999998888');
  assert.equal(mask('5511999998888'), '551199***8888');
});

test('SessionStore cria, persiste e recarrega sessao com flush()', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-sessions-'));
  const file = path.join(dir, 'sessions.json');
  const store = new SessionStore(file, { now: () => 1700000000000 });
  await store.load();
  const s = store.get('5511999998888');
  s.history.push({ role: 'user', content: 'oi' });
  store.touch(s);
  await store.flush();

  const store2 = new SessionStore(file, { now: () => 1700000000000 });
  await store2.load();
  assert.equal(store2.get('5511999998888').history.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('SessionStore.flush() loga e propaga erro de gravacao em disco', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-sessions-err-'));
  // Aponta file para um diretório existente para forçar erro no rename/writeFile
  const badFile = dir;
  const errors = [];
  const store = new SessionStore(badFile, {
    logger: { error: (...args) => errors.push(args.join(' ')) }
  });
  store.get('5511999998888');
  await assert.rejects(() => store.flush());
  assert.ok(errors.some((e) => e.includes('falha de gravação')));
  await fs.rm(dir, { recursive: true, force: true });
});

test('SessionStore.purge() remove sessoes expiradas sem legalHold', () => {
  const now = 1700000000000;
  const store = new SessionStore(path.join(os.tmpdir(), 'unused.json'), {
    now: () => now,
    ttlMs: 1000
  });
  store.sessions['5511999998888'] = { phone: '5511999998888', updatedAt: new Date(now - 5000).toISOString() };
  store.sessions['5511999997777'] = { phone: '5511999997777', legalHold: true, updatedAt: new Date(now - 5000).toISOString() };
  const removed = store.purge();
  assert.equal(removed, 1);
  assert.equal(store.sessions['5511999998888'], undefined);
  assert.ok(store.sessions['5511999997777']);
});
