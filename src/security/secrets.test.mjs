import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { ApiSettingsStore } from '../api-settings.mjs';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secrets.mjs';

const KEY = Buffer.alloc(32, 7).toString('base64');

test('segredos usam AES-256-GCM, autenticam o campo e não persistem em texto claro', () => {
  const ciphertext = encryptSecret('provider-api-key-123', { key: KEY, context: 'provider:test' });
  assert.ok(isEncryptedSecret(ciphertext));
  assert.notEqual(ciphertext, 'provider-api-key-123');
  assert.equal(decryptSecret(ciphertext, { key: KEY, context: 'provider:test' }), 'provider-api-key-123');
  assert.throws(() => decryptSecret(ciphertext, { key: KEY, context: 'provider:other' }), /api_secret_decryption_failed/);
});

test('API settings migra segredos do ambiente, criptografa no disco e impede ressurgimento após limpar', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-secret-settings-'));
  const filePath = path.join(dir, 'api-settings.json');
  const originalEnvSecret = 'AIzaLegacyEnvironmentSecret123';
  try {
    const targetConfig = {
      geminiKey: originalEnvSecret,
      groqKey: 'gskLegacyEnvironmentSecret456',
      openrouterBaseUrl: 'https://openrouter.ai/api/v1'
    };
    const store = new ApiSettingsStore({
      filePath,
      targetConfig,
      secretEncryptionKey: KEY,
      logger: { info() {}, warn() {}, error() {} }
    });
    await store.load();
    assert.equal(targetConfig.geminiKey, originalEnvSecret);
    assert.equal(targetConfig.groqKey, 'gskLegacyEnvironmentSecret456');
    assert.equal(store.getSafeView().items.find(item => item.key === 'geminiKey').source, 'panel');
    const rawFile = await readFile(filePath, 'utf8');
    assert.equal(rawFile.includes(originalEnvSecret), false);
    assert.equal(rawFile.includes('gskLegacyEnvironmentSecret456'), false);
    assert.match(rawFile, /lia-secret:v1:/);
    await store.update({ geminiKey: 'AIzaPanelReplacementSecret789', openrouterBaseUrl: 'https://example.com/v1/' });
    assert.equal(targetConfig.geminiKey, 'AIzaPanelReplacementSecret789');
    assert.equal(targetConfig.openrouterBaseUrl, 'https://example.com/v1');
    await store.update({ geminiKey: '__CLEAR__' });
    assert.equal(targetConfig.geminiKey, '');
    const restartedConfig = { geminiKey: originalEnvSecret };
    const restarted = new ApiSettingsStore({
      filePath,
      targetConfig: restartedConfig,
      secretEncryptionKey: KEY,
      logger: { info() {}, warn() {}, error() {} }
    });
    await restarted.load();
    assert.equal(restartedConfig.geminiKey, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('API settings migra credenciais legadas para a projeção Supabase criptografadas', async () => {
  const writes = [];
  const client = {
    enabled: true,
    async select() { return [{ key: 'api_runtime_settings', payload: { overrides: {} }, updated_at: null }]; },
    async upsert(table, rows, conflict) { writes.push({ table, rows, conflict }); return rows; }
  };
  const targetConfig = {
    groqKey: 'gskEnvLegacySupabaseMigration',
    googleCalendarApiKey: 'googleCalendarLegacyKey',
    googleCalendarAccessToken: 'googleCalendarLegacyToken',
    googleDriveAccessToken: 'googleDriveLegacyToken',
    googleSheetsAccessToken: 'googleSheetsLegacyToken',
    googleGmailAccessToken: 'googleGmailLegacyToken',
    googleServiceAccountJson: '{"type":"service_account","private_key":"legacy"}'
  };
  const store = new ApiSettingsStore({
    client,
    targetConfig,
    secretEncryptionKey: KEY,
    logger: { info() {}, warn() {}, error() {} }
  });
  await store.load();
  assert.equal(targetConfig.groqKey, 'gskEnvLegacySupabaseMigration');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].table, 'runtime_projections');
  const stored = writes[0].rows[0].payload.overrides;
  for (const key of ['groqKey', 'googleCalendarApiKey', 'googleCalendarAccessToken', 'googleDriveAccessToken', 'googleSheetsAccessToken', 'googleGmailAccessToken', 'googleServiceAccountJson']) {
    assert.ok(isEncryptedSecret(stored[key]), `${key} deve ser criptografado`);
    assert.equal(stored[key].includes('Legacy'), false);
  }
});
