import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { ApiSettingsStore } from '../api-settings.mjs';
import { decryptSecret, encryptSecret, isEncryptedSecret, needsReencryption, secretKeyId } from './secrets.mjs';

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
    assert.match(rawFile, /lia-secret:v2:/);
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

const KEY_A = Buffer.alloc(32, 11).toString('base64');
const KEY_B = Buffer.alloc(32, 22).toString('base64');

test('segredos v2 carregam kid e abrem com chave anterior durante a rotação', () => {
  const stored = encryptSecret('chave-secreta', { key: KEY_A, context: 'ctx' });
  assert.match(stored, /^lia-secret:v2:[0-9a-f]{8}:/);
  assert.equal(secretKeyId(stored), secretKeyId(encryptSecret('outro', { key: KEY_A, context: 'ctx' })));
  assert.notEqual(secretKeyId(stored), secretKeyId(encryptSecret('x', { key: KEY_B, context: 'ctx' })));
  assert.equal(decryptSecret(stored, { key: KEY_B, previousKeys: [KEY_A], context: 'ctx' }), 'chave-secreta');
  assert.throws(() => decryptSecret(stored, { key: KEY_B, context: 'ctx' }), /api_secret_key_unavailable/);
  assert.equal(needsReencryption(stored, { key: KEY_B, previousKeys: [KEY_A] }), true);
  assert.equal(needsReencryption(stored, { key: KEY_A }), false);
});

test('valores v1 legados continuam abrindo e são marcados para recriptografia', async () => {
  const { createCipheriv, randomBytes } = await import('node:crypto');
  const key = Buffer.from(KEY_A, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('ctx'));
  const enc = Buffer.concat([cipher.update('legado', 'utf8'), cipher.final()]);
  const v1 = 'lia-secret:v1:' + [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
  assert.ok(isEncryptedSecret(v1));
  assert.equal(secretKeyId(v1), null);
  assert.equal(decryptSecret(v1, { key: KEY_A, context: 'ctx' }), 'legado');
  assert.equal(decryptSecret(v1, { key: KEY_B, previousKeys: [KEY_A], context: 'ctx' }), 'legado');
  assert.equal(needsReencryption(v1, { key: KEY_A }), true);
  assert.throws(() => decryptSecret(v1, { key: KEY_B, context: 'ctx' }), /api_secret_decryption_failed/);
});

test('API_SECRETS_PREVIOUS_KEYS do ambiente habilita a rotação sem chave explícita', () => {
  const saved = { cur: process.env.API_SECRETS_ENCRYPTION_KEY, prev: process.env.API_SECRETS_PREVIOUS_KEYS };
  try {
    process.env.API_SECRETS_ENCRYPTION_KEY = KEY_A;
    delete process.env.API_SECRETS_PREVIOUS_KEYS;
    const stored = encryptSecret('valor', { context: 'ctx' });
    process.env.API_SECRETS_ENCRYPTION_KEY = KEY_B;
    assert.throws(() => decryptSecret(stored, { context: 'ctx' }), /api_secret_key_unavailable/);
    process.env.API_SECRETS_PREVIOUS_KEYS = `${KEY_A}, `;
    assert.equal(decryptSecret(stored, { context: 'ctx' }), 'valor');
  } finally {
    for (const [name, value] of [['API_SECRETS_ENCRYPTION_KEY', saved.cur], ['API_SECRETS_PREVIOUS_KEYS', saved.prev]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('ApiSettingsStore recriptografa segredo cifrado com chave anterior ao carregar', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-secret-rotate-'));
  const filePath = path.join(dir, 'api-settings.json');
  try {
    const first = new ApiSettingsStore({ filePath, targetConfig: { openrouterBaseUrl: 'https://openrouter.ai/api/v1' }, secretEncryptionKey: KEY_A, logger: { info() {}, warn() {}, error() {} } });
    await first.load();
    await first.update({ geminiKey: 'AIzaRotacao123456789' });
    const before = JSON.parse(await readFile(filePath, 'utf8'));
    const kidBefore = secretKeyId(JSON.stringify(before).match(/lia-secret:v2:[^"]+/)?.[0]);

    const target = { openrouterBaseUrl: 'https://openrouter.ai/api/v1' };
    const rotated = new ApiSettingsStore({ filePath, targetConfig: target, secretEncryptionKey: KEY_B, logger: { info() {}, warn() {}, error() {} } });
    process.env.API_SECRETS_PREVIOUS_KEYS = KEY_A;
    try { await rotated.load(); } finally { delete process.env.API_SECRETS_PREVIOUS_KEYS; }
    assert.equal(target.geminiKey, 'AIzaRotacao123456789');
    const after = await readFile(filePath, 'utf8');
    assert.notEqual(secretKeyId(after.match(/lia-secret:v2:[^"]+/)?.[0]), kidBefore);
    assert.ok(!after.includes('AIzaRotacao123456789'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
