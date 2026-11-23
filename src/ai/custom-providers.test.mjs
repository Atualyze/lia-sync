import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { CustomProviderStore, getCustomProvider } from './custom-providers.mjs';

const KEY = Buffer.alloc(32, 9).toString('base64');

test('provedores personalizados criptografam a chave persistida e restauram após restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-custom-provider-secret-'));
  const filePath = path.join(dir, 'custom-ai-providers.json');
  try {
    const first = new CustomProviderStore({ filePath, secretEncryptionKey: KEY, logger: { info() {}, warn() {}, error() {} } });
    await first.load();
    const saved = await first.upsert({
      id: 'providerx',
      name: 'Provider X',
      baseUrl: 'https://api.providerx.example/v1',
      defaultModel: 'providerx-model',
      apiKey: 'provider-x-secret-value'
    });
    assert.equal(saved.configured, true);
    const raw = await readFile(filePath, 'utf8');
    assert.equal(raw.includes('provider-x-secret-value'), false);
    assert.match(raw, /lia-secret:v1:/);
    const second = new CustomProviderStore({ filePath, secretEncryptionKey: KEY, logger: { info() {}, warn() {}, error() {} } });
    await second.load();
    assert.equal(getCustomProvider('providerx').apiKey, 'provider-x-secret-value');
    assert.equal(second.listSafe()[0].maskedKey.includes('provider-x-secret-value'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('provedores personalizados migram chaves legadas em texto claro para armazenamento criptografado', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-custom-provider-legacy-'));
  const filePath = path.join(dir, 'custom-ai-providers.json');
  const legacyKey = 'legacy-provider-secret-987654';
  try {
    await writeFile(filePath, JSON.stringify({
      providers: [{
        id: 'legacyx',
        name: 'Legacy X',
        baseUrl: 'https://api.legacyx.example/v1',
        apiKey: legacyKey,
        defaultModel: 'legacy-model',
        enabled: true
      }]
    }), 'utf8');

    const store = new CustomProviderStore({
      filePath,
      secretEncryptionKey: KEY,
      logger: { info() {}, warn() {}, error() {} }
    });
    await store.load();

    assert.equal(getCustomProvider('legacyx').apiKey, legacyKey);
    const persisted = await readFile(filePath, 'utf8');
    assert.equal(persisted.includes(legacyKey), false);
    assert.match(persisted, /lia-secret:v1:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
