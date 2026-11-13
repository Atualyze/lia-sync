import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdminConfigStore, DEFAULT_BOT_CONFIG, clone, normalizeBotConfig, validateBotConfig } from './admin-config.mjs';
import { handleBridgeRoutes } from './http/bridge-routes.mjs';
import { SupabaseAdminConfigStore } from './supabase-runtime.mjs';

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = body; }
  };
}

function request({ method = 'GET', headers = {} } = {}) {
  return { method, headers, async *[Symbol.asyncIterator]() {} };
}

function adminConfig({ persistence = 'supabase', revision = 7, active = clone(DEFAULT_BOT_CONFIG), history = [] } = {}) {
  return {
    persistence,
    revision,
    active,
    history: history.length ? history : [{ revision, action: 'published', at: '2026-11-13T12:00:00.000Z', snapshot: clone(active) }]
  };
}

async function readBridge({ req = request(), config = adminConfig(), webhookAuthorize = async () => true } = {}) {
  const res = response();
  await handleBridgeRoutes({
    req,
    res,
    u: new URL('http://lia.test/api/bridge/v1/config'),
    store: {},
    f: {},
    webhookAuthorize,
    adminConfig: config
  });
  return res;
}

test('normaliza a opção legada de busca web para o campo público e remove a cópia antiga', () => {
  const normalized = normalizeBotConfig({ automation: { enableWebSearch: false } });
  assert.equal(normalized.webSearch.enabled, false);
  assert.equal(Object.hasOwn(normalized.automation, 'enableWebSearch'), false);
});

test('valida campos operacionais e não aceita tipos ou limites inválidos', () => {
  const config = clone(DEFAULT_BOT_CONFIG);
  config.ai.agentMode = 'super_agente';
  config.ai.enableToolCalling = true;
  config.automation.enableMediaProcessing = false;
  config.automation.enableProactiveFollowUp = true;
  config.automation.businessHoursOnly = false;
  config.automation.autoHandoffOnHumanPresence = true;
  config.automation.maxDailyFollowUps = 12;
  config.automation.followUpMinHours = 8;
  config.automation.followUpMaxHours = 48;
  config.automation.followUpTemplate = 'Retorno personalizado';
  config.voice.voiceName = 'Kore';
  config.voice.tone = 'Calmo';
  config.voice.autoVoiceOnAudio = false;
  assert.deepEqual(validateBotConfig(config), []);

  config.automation.maxDailyFollowUps = -1;
  config.voice.voiceName = 'unsupported';
  assert.ok(validateBotConfig(config).some(error => /limite diário/i.test(error)));
  assert.ok(validateBotConfig(config).some(error => /voz suportada/i.test(error)));
});

test('publish falha fechado quando há cliente Supabase habilitado mas persistência remota não foi confirmada', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-admin-publish-'));
  try {
    const store = new AdminConfigStore(path.join(dir, 'bot-config.json'));
    await store.load();
    store.client = { enabled: true };
    store.persistence = 'local';
    store.remoteError = 'remote unavailable';
    const beforeRevision = store.revision;
    const result = await store.publish('test');
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /Supabase|persistência/i);
    assert.equal(store.revision, beforeRevision);
    assert.equal(store.persistence, 'local');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rollback falha fechado e restaura a revisão ativa anterior quando Supabase não confirma persistência', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-admin-rollback-'));
  try {
    const store = new AdminConfigStore(path.join(dir, 'bot-config.json'));
    await store.load();
    const published = await store.publish('test');
    assert.equal(published.ok, true);
    const beforeRevision = store.revision;
    const beforeActive = store.snapshot().active;
    store.client = { enabled: true };
    store.persistence = 'local';
    store.remoteError = 'remote unavailable';

    const result = await store.rollback(1, 'test');
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /Supabase|persistência/i);
    assert.equal(store.revision, beforeRevision);
    assert.deepEqual(store.snapshot().active, beforeActive);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('falha na leitura inicial do Supabase não grava defaults locais nem permite publicar', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-admin-read-failure-'));
  let writes = 0;
  try {
    const store = new SupabaseAdminConfigStore(path.join(dir, 'bot-config.json'), {
      client: {
        enabled: true,
        async select() { throw new Error('remote read unavailable'); },
        async upsert() { writes += 1; }
      },
      logger: { warn() {} }
    });
    await store.load();
    assert.equal(store.persistence, 'fallback');
    assert.equal(writes, 0);
    const result = await store.publish('test');
    assert.equal(result.ok, false);
    assert.equal(writes, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ausência confirmada de linha ativa inicializa estado Supabase sem alterar migrations', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-admin-empty-state-'));
  const writes = [];
  try {
    const store = new SupabaseAdminConfigStore(path.join(dir, 'bot-config.json'), {
      client: {
        enabled: true,
        async select(table) { return table === 'bot_config_state' ? [] : []; },
        async upsert(table, rows) { writes.push({ table, rows }); }
      },
      logger: { warn() {} }
    });
    await store.load();
    assert.equal(store.persistence, 'supabase');
    assert.ok(writes.some(item => item.table === 'bot_config_state'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('bridge nega leitura sem autorização antes de expor configuração publicada', async () => {
  const res = await readBridge({ webhookAuthorize: async () => false });
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'unauthorized' });
});

test('bridge expõe somente allowlist da configuração publicada e retorna ETag com suporte a 304', async () => {
  const active = clone(DEFAULT_BOT_CONFIG);
  active.ai.activeModel = 'model-public';
  active.ai.apiKey = 'DO_NOT_EXPOSE_THIS_SECRET';
  active.human.phone = '5511999999999';
  const config = adminConfig({ active });
  const first = await readBridge({ config });
  assert.equal(first.status, 200);
  assert.match(first.headers.etag, /^"lia-config-v1-7-/);
  const payload = JSON.parse(first.body);
  assert.equal(payload.revision, 7);
  assert.equal(payload.settings.ai.activeModel, 'model-public');
  assert.equal(payload.settings.automation.autoHandoffOnHumanPresence, true);
  assert.equal(JSON.stringify(payload).includes('DO_NOT_EXPOSE_THIS_SECRET'), false);
  assert.equal(JSON.stringify(payload).includes('apiKey'), false);
  assert.equal(JSON.stringify(payload).includes('5511999999999'), false);

  const second = await readBridge({ config, req: request({ headers: { 'if-none-match': first.headers.etag } }) });
  assert.equal(second.status, 304);
  assert.equal(second.body, '');
  assert.equal(second.headers.etag, first.headers.etag);
});

test('bridge não entrega draft, configuração não publicada ou estado sem persistência Supabase', async () => {
  const missingPublished = await readBridge({ config: { persistence: 'supabase', revision: 0, active: null, history: [] } });
  assert.equal(missingPublished.status, 503);
  assert.deepEqual(JSON.parse(missingPublished.body), { ok: false, error: 'published_config_unavailable' });

  const localFallback = await readBridge({ config: adminConfig({ persistence: 'local' }) });
  assert.equal(localFallback.status, 503);
  assert.deepEqual(JSON.parse(localFallback.body), { ok: false, error: 'config_persistence_unavailable' });
});

test('expediente válido passa na validação e publica', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-admin-hours-'));
  try {
    const store = new AdminConfigStore(path.join(dir, 'bot-config.json'));
    await store.load();
    const result = await store.updateDraft({
      business: { hoursConfig: { enabled: true, timezone: 'America/Sao_Paulo', start: '08:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], autoResumeOnOpen: true, outOfHoursNotice: 'Voltamos em breve.' } }
    }, 'test');
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    // Antes de publicar, só o rascunho reflete o novo expediente.
    assert.equal(result.snapshot.hoursPreview.enabled, false);
    assert.equal(result.snapshot.hoursDraftPreview.enabled, true);
    assert.equal(typeof result.snapshot.hoursDraftPreview.summary, 'string');
    const published = await store.publish('test');
    assert.equal(published.ok, true);
    assert.equal(published.snapshot.hoursPreview.enabled, true);
    assert.equal(published.snapshot.active.business.hoursConfig.enabled, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('expediente inválido falha fechado antes de qualquer publicação', () => {
  const base = () => {
    const config = clone(DEFAULT_BOT_CONFIG);
    config.business.hoursConfig = { enabled: true, timezone: 'America/Sao_Paulo', start: '08:00', end: '18:00', weekdays: [1, 2, 3, 4, 5], autoResumeOnOpen: true, outOfHoursNotice: 'x' };
    return config;
  };
  assert.deepEqual(validateBotConfig(base()), []);

  const inverted = base(); inverted.business.hoursConfig.end = '07:00';
  assert.ok(validateBotConfig(inverted).some(error => /fim da janela deve ser depois/i.test(error)));

  const malformed = base(); malformed.business.hoursConfig.start = '8h';
  assert.ok(validateBotConfig(malformed).some(error => /formato HH:MM/i.test(error)));

  const emptyDays = base(); emptyDays.business.hoursConfig.weekdays = [];
  assert.ok(validateBotConfig(emptyDays).some(error => /ao menos um dia/i.test(error)));

  const outOfRange = base(); outOfRange.business.hoursConfig.weekdays = [1, 7];
  assert.ok(validateBotConfig(outOfRange).some(error => /entre 0 \(domingo\) e 6/i.test(error)));

  const duplicated = base(); duplicated.business.hoursConfig.weekdays = [1, 1, 2];
  assert.ok(validateBotConfig(duplicated).some(error => /Não repita o mesmo dia/i.test(error)));

  const badTimezone = base(); badTimezone.business.hoursConfig.timezone = 'Marte/Olimpo';
  assert.ok(validateBotConfig(badTimezone).some(error => /fuso horário/i.test(error)));

  const notBoolean = base(); notBoolean.business.hoursConfig.enabled = 'sim';
  assert.ok(validateBotConfig(notBoolean).some(error => /verdadeiro\/falso/i.test(error)));

  const longNotice = base(); longNotice.business.hoursConfig.outOfHoursNotice = 'a'.repeat(2001);
  assert.ok(validateBotConfig(longNotice).some(error => /2000 caracteres/i.test(error)));

  const brokenShape = clone(DEFAULT_BOT_CONFIG);
  brokenShape.business.hoursConfig = ['não', 'é', 'objeto'];
  assert.deepEqual(validateBotConfig(brokenShape), ['A janela de atendimento deve ser um objeto de configuração.']);
});
