import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SectorProjection, SectorProjectionError, normalizeSectors, MAX_SECTORS } from './sectors.mjs';
import { handleBridgeRoutes } from './http/bridge-routes.mjs';
import { AdminConfigStore, DEFAULT_BOT_CONFIG, clone } from './admin-config.mjs';

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = body; }
  };
}

function request({ method = 'PUT', headers = {}, payload }) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; }
  };
}

async function bridge({ req, method = 'PUT', payload, webhookAuthorize = async () => true, sectorProjection, adminConfig }) {
  const res = response();
  await handleBridgeRoutes({
    req: req || request({ method, payload }),
    res,
    u: new URL('http://lia.test/api/bridge/v1/sectors'),
    store: {},
    f: {},
    webhookAuthorize,
    adminConfig,
    sectorProjection
  });
  return res;
}

async function tempFile(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-sectors-'));
  return { dir, file: path.join(dir, name) };
}

test('normalizeSectors mantém apenas os campos usados pela triagem leve', () => {
  const sectors = normalizeSectors([
    { id: 'sec_comercial', name: 'Comercial & Orçamentos', description:  '  Propostas e planos  ', phone: '5511999999999', routingMode: 'external_whatsapp', isActive: true },
    { id: 'sec_suporte', name: 'Suporte', isActive: false }
  ]);
  assert.deepEqual(sectors, [
    { id: 'sec_comercial', name: 'Comercial & Orçamentos', description: 'Propostas e planos', isActive: true },
    { id: 'sec_suporte', name: 'Suporte', description: '', isActive: false }
  ]);
  assert.equal(JSON.stringify(sectors).includes('5511999999999'), false, 'telefone de setor não pode ser projetado');
});

test('normalizeSectors rejeita listas inválidas, duplicadas e acima do limite', () => {
  assert.throws(() => normalizeSectors('não é lista'), SectorProjectionError);
  assert.throws(() => normalizeSectors([{ id: '', name: 'Sem id' }]), /invalid_sectors/);
  assert.throws(() => normalizeSectors([{ id: 'a', name: 'A' }, { id: 'a', name: 'A repetido' }]), /duplicate_sector_id/);
  assert.throws(() => normalizeSectors(Array.from({ length: MAX_SECTORS + 1 }, (_, index) => ({ id: `s${index}`, name: `Setor ${index}` }))), /too_many_sectors/);
});

test('projeção persiste em arquivo próprio, recarrega e falha fechado sem tocar em configuração', async () => {
  const { dir, file } = await tempFile('sectors-projection.json');
  try {
    const projection = new SectorProjection(file);
    await projection.load();
    assert.deepEqual(projection.list(), []);
    assert.equal(projection.status().synced, false);

    const status = await projection.replace([{ id: 'sec_financeiro', name: 'Financeiro', description: 'Boletos e pix', isActive: true }]);
    assert.equal(status.synced, true);
    assert.equal(status.count, 1);

    const reloaded = new SectorProjection(file);
    await reloaded.load();
    assert.deepEqual(reloaded.list(), [{ id: 'sec_financeiro', name: 'Financeiro', description: 'Boletos e pix', isActive: true }]);

    // Persistência inválida mantém a projeção anterior intacta.
    const before = reloaded.list();
    await assert.rejects(() => reloaded.replace('corrompido'), SectorProjectionError);
    assert.deepEqual(reloaded.list(), before);
    assert.equal(JSON.stringify(reloaded.status()).includes('bot-config'), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rota de setores exige autorização de máquina e não altera rascunho nem revisão', async () => {
  const { dir, file } = await tempFile('sectors-projection.json');
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-sectors-admin-'));
  try {
    const admin = new AdminConfigStore(path.join(configDir, 'bot-config.json'));
    await admin.load();
    await admin.publish('test');
    const projection = new SectorProjection(file);
    await projection.load();
    const revisionBefore = admin.revision;
    const draftBefore = JSON.stringify(admin.draft);
    const activeBefore = JSON.stringify(admin.active);

    const denied = await bridge({ payload: { sectors: [{ id: 'a', name: 'A' }] }, webhookAuthorize: async () => false, sectorProjection: projection, adminConfig: admin });
    assert.equal(denied.status, 401);
    assert.deepEqual(projection.list(), []);

    const ok = await bridge({ payload: { sectors: [{ id: 'sec_comercial', name: 'Comercial', isActive: true }] }, sectorProjection: projection, adminConfig: admin });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, contractVersion: 1, synced: true, count: 1, updatedAt: JSON.parse(ok.body).updatedAt });

    const invalid = await bridge({ payload: { sectors: [{ name: 'sem id' }] }, sectorProjection: projection, adminConfig: admin });
    assert.equal(invalid.status, 400);
    assert.deepEqual(JSON.parse(invalid.body), { ok: false, error: 'invalid_sectors' });
    assert.equal(projection.status().count, 1, 'rejeição não pode apagar a projeção válida anterior');

    const read = await bridge({ method: 'GET', sectorProjection: projection, adminConfig: admin });
    assert.equal(read.status, 200);
    assert.equal(JSON.parse(read.body).sectors[0].id, 'sec_comercial');

    const wrongMethod = await bridge({ method: 'DELETE', sectorProjection: projection, adminConfig: admin });
    assert.equal(wrongMethod.status, 405);

    assert.equal(admin.revision, revisionBefore, 'projeção de setores jamais publica nova revisão');
    assert.equal(JSON.stringify(admin.draft), draftBefore);
    assert.equal(JSON.stringify(admin.active), activeBefore);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

test('rota de setores falha fechado quando a projeção está indisponível', async () => {
  const res = await bridge({ payload: { sectors: [] }, sectorProjection: null });
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'sector_projection_unavailable' });
});

test('config publicada mantém o horário dentro da allowlist e sem segredos', async () => {
  const active = clone(DEFAULT_BOT_CONFIG);
  active.business.hoursConfig = {
    enabled: true, timezone: 'America/Sao_Paulo', start: '09:00', end: '12:00',
    weekdays: [1, 3, 5], outOfHoursNotice: 'Aviso interno que não deve sair daqui', autoResumeOnOpen: true
  };
  active.human.phone = '5511999999999';
  const res = await handlePublishedConfigReadTest(active);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  const hours = payload.settings.business.hours;
  assert.equal(hours.enabled, true);
  assert.deepEqual(hours.weekdays, [1, 3, 5]);
  assert.equal(typeof hours.summary, 'string');
  assert.equal(hours.summary.includes('Aviso interno'), false);
  assert.equal(JSON.stringify(payload).includes('Aviso interno que não deve sair daqui'), false, 'texto do aviso não é configuração operacional');
  assert.equal(JSON.stringify(payload).includes('5511999999999'), false);
  assert.equal(JSON.stringify(payload).includes('outOfHoursNotice'), false);
});

async function handlePublishedConfigReadTest(active) {
  const res = response();
  await handleBridgeRoutes({
    req: { method: 'GET', headers: {}, async *[Symbol.asyncIterator]() {} },
    res,
    u: new URL('http://lia.test/api/bridge/v1/config'),
    store: {},
    f: {},
    webhookAuthorize: async () => true,
    adminConfig: {
      persistence: 'supabase',
      revision: 4,
      active,
      history: [{ revision: 4, action: 'published', at: '2026-11-13T12:00:00.000Z' }]
    }
  });
  return res;
}
