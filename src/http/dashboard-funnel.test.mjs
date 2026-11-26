import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleDashboardSettingsRoutes } from './dashboard.mjs';

function makeReq(method, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function makeRes() {
  const out = { statusCode: 0, body: null };
  return {
    out,
    writeHead(code) { out.statusCode = code; },
    end(chunk) { out.body = chunk ? JSON.parse(String(chunk)) : null; },
  };
}

test('POST /api/dashboard/funnel-stage atualiza etapa e rejeita etapa inválida', async () => {
  const session = { phone: '5511999990000', history: [{ role: 'user', content: 'oi' }] };
  let dirty = false;
  const store = {
    get: (p) => (p === '5511999990000' ? session : null),
    markDirty: () => { dirty = true; },
    flush: async () => {},
  };

  // Etapa inválida -> 400
  const resBad = makeRes();
  await handleDashboardSettingsRoutes({
    req: makeReq('POST', { phone: '5511999990000', stage: 'etapa_inexistente' }),
    res: resBad,
    u: new URL('http://localhost/api/dashboard/funnel-stage'),
    store,
    adminConfig: { active: {} },
  });
  assert.equal(resBad.out.statusCode, 400);
  assert.equal(resBad.out.body.error, 'invalid_stage');

  // Etapa válida -> 200
  const resOk = makeRes();
  await handleDashboardSettingsRoutes({
    req: makeReq('POST', { phone: '5511999990000', stage: 'agendado' }),
    res: resOk,
    u: new URL('http://localhost/api/dashboard/funnel-stage'),
    store,
    adminConfig: { active: {} },
  });
  assert.equal(resOk.out.statusCode, 200);
  assert.equal(resOk.out.body.stage, 'agendado');
  assert.equal(session.funnelStage, 'agendado');
  assert.equal(dirty, true);
});

test('PUT /api/dashboard/missed-call persiste via updateDraft e publish', async () => {
  let drafted = null;
  let published = false;
  const adminConfig = {
    active: {},
    async updateDraft(patch) { drafted = patch; return { ok: true }; },
    async publish() { published = true; Object.assign(this.active, drafted); return { ok: true }; },
  };
  const res = makeRes();
  await handleDashboardSettingsRoutes({
    req: makeReq('PUT', { enabled: true, delaySeconds: 45, message: 'Oi! Vi sua ligação.' }),
    res,
    u: new URL('http://localhost/api/dashboard/missed-call'),
    store: {},
    adminConfig,
  });
  assert.equal(res.out.statusCode, 200);
  assert.equal(published, true);
  assert.equal(adminConfig.active.missedCall.enabled, true);
  assert.equal(adminConfig.active.missedCall.delaySeconds, 45);
});

test('POST /api/dashboard/crm-contact e /api/dashboard/canned-responses persistem CRM e macros', async () => {
  const session = { phone: '5511999990000', history: [] };
  let flushed = false;
  const store = {
    get: (p) => (p === '5511999990000' ? session : null),
    markDirty: () => {},
    flush: async () => { flushed = true; },
  };
  const adminConfig = {
    active: {},
    async updateDraft(patch) { this._draft = patch; return { ok: true }; },
    async publish() { Object.assign(this.active, this._draft); return { ok: true }; },
  };

  const resCrm = makeRes();
  await handleDashboardSettingsRoutes({
    req: makeReq('POST', {
      phone: '5511999990000',
      clientName: 'Ana Paula',
      email: 'ana@exemplo.com',
      dealValue: '1500.50',
      tags: 'vip, retorno',
      sectorId: 'vendas',
      notes: 'Pediu proposta para sexta',
      funnelStage: 'agendado',
    }),
    res: resCrm,
    u: new URL('http://localhost/api/dashboard/crm-contact'),
    store,
    adminConfig,
  });
  assert.equal(resCrm.out.statusCode, 200);
  assert.equal(flushed, true);
  assert.equal(session.dealValue, 1500.5);
  assert.deepEqual(session.tags, ['vip', 'retorno']);
  assert.equal(session.sectorId, 'vendas');
  assert.equal(session.funnelStage, 'agendado');

  const resMacro = makeRes();
  await handleDashboardSettingsRoutes({
    req: makeReq('POST', { shortcut: '/pix', title: 'Chave Pix', content: 'Nossa chave Pix é 12.345.678/0001-90' }),
    res: resMacro,
    u: new URL('http://localhost/api/dashboard/canned-responses'),
    store,
    adminConfig,
  });
  assert.equal(resMacro.out.statusCode, 200);
  assert.equal(adminConfig.active.cannedResponses.length, 1);
  assert.equal(adminConfig.active.cannedResponses[0].shortcut, 'pix');
});
