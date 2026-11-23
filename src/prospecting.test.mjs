import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBotConfig, validateBotConfig } from './admin-config.mjs';
import { toolConsultarDadosBrasil } from './tools/consultar_dados_brasil.mjs';
import {
  ProspectLeadStore,
  importProspectLeads,
  evaluateProspectGuards,
  isWithinBusinessWindow,
  runProspectingTick,
  handleInboundOptOut,
  isOptOutMessage
} from './prospecting/index.mjs';

test('admin-config: normalizes timezone across business and googleCalendar and validates style.emoji', () => {
  const normalized = normalizeBotConfig({
    business: { hoursConfig: { timezone: 'America/Fortaleza' } },
    style: { emoji: 'off' }
  });
  assert.equal(normalized.business.timezone, 'America/Fortaleza');
  assert.equal(normalized.integrations.googleCalendar.timezone, 'America/Fortaleza');
  assert.equal(normalized.style.emoji, 'off');

  const okErrors = validateBotConfig(normalized);
  assert.equal(okErrors.length, 0);

  const badErrors = validateBotConfig({ style: { emoji: 'invalid_mode' } });
  assert.ok(badErrors.some(e => e.includes('Estilo de emojis')));
});

test('consultar_dados_brasil: falls back to publica.cnpj.ws when BrasilAPI returns 403', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('brasilapi.com.br')) {
      return new Response('Forbidden', { status: 403 });
    }
    if (String(url).includes('publica.cnpj.ws')) {
      return new Response(JSON.stringify({
        razao_social: 'EMPRESA TESTE LTDA',
        estabelecimento: {
          nome_fantasia: 'Empresa Teste',
          situacao_cadastral: 'Ativa',
          atividade_principal: { descricao: 'Desenvolvimento de software' },
          logradouro: 'Av Paulista',
          numero: '1000',
          bairro: 'Bela Vista',
          cidade: { nome: 'São Paulo' },
          estado: { sigla: 'SP' },
          cep: '01310100'
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const res = await toolConsultarDadosBrasil.execute({ acao: 'consultar_cnpj', cnpj: '11.222.333/0001-81' });
    assert.equal(res.success, true);
    assert.equal(res.razaoSocial, 'EMPRESA TESTE LTDA');
    assert.equal(res.uf, 'SP');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('prospecting importer: normalizes phones, deduplicates and rejects non-mobile numbers', () => {
  const csv = [
    'nome,telefone,segmento',
    'Ana,(85) 99999-1111,Clinica',
    'Ana Duplicada,5585999991111,Clinica',
    'Fixo,(85) 3222-1111,Loja',
    'Beto,11988887777,Imobiliaria'
  ].join('\n');

  const { leads, rejected } = importProspectLeads(csv);
  assert.equal(leads.length, 2);
  assert.equal(leads[0].phone, '5585999991111');
  assert.equal(leads[1].phone, '5511988887777');
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].reason, 'duplicate');
  assert.equal(rejected[1].reason, 'invalid_mobile');
});

test('prospecting optout: detects opt-out, suppresses phone and marks lead opted_out', async () => {
  assert.equal(isOptOutMessage('SAIR'), true);
  assert.equal(isOptOutMessage('Não quero mais receber mensagens'), true);
  assert.equal(isOptOutMessage('Oi, quero saber o preço'), false);

  const leadStore = new ProspectLeadStore();
  const list = await leadStore.createList({ name: 'Lista 1', status: 'active' });
  await leadStore.addLeads(list.id, [{ phone: '5585999991111', name: 'Ana' }]);

  const suppressions = [];
  const sent = [];
  const campaignStore = {
    addSuppression: async item => { suppressions.push(item); }
  };

  const result = await handleInboundOptOut({
    phone: '5585999991111',
    text: 'pare',
    campaignStore,
    prospectStore: leadStore,
    send: async (to, msg) => { sent.push({ to, msg }); }
  });

  assert.equal(result.matched, true);
  assert.equal(suppressions.length, 1);
  assert.equal(suppressions[0].reason, 'Solicitação de opt-out');
  assert.equal(sent.length, 1);
  assert.equal(/\p{Extended_Pictographic}/u.test(sent[0].msg), false);

  const due = await leadStore.listDueLeads();
  assert.equal(due.length, 0);
});

const PROSPECT_TZ = 'America/Fortaleza';

function fortalezaParts(date) {
  const map = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: PROSPECT_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]));
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function fortalezaLocalToDate(year, month, day, hour, minute) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetAt = instant => {
    const shown = fortalezaParts(new Date(instant));
    return Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second) - instant;
  };
  let utc = asUtc - offsetAt(asUtc);
  utc = asUtc - offsetAt(utc);
  return new Date(utc);
}

/** Tick clock on or after `from`, always inside Mon–Sat 09:00–18:00 Fortaleza. */
function businessTickNow(from = new Date()) {
  const start = new Date(from);
  if (isWithinBusinessWindow({ now: start, timeZone: PROSPECT_TZ })) return start;
  const local = fortalezaParts(start);
  for (let add = 0; add < 8; add++) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + add));
    const candidate = fortalezaLocalToDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 14, 0);
    if (candidate.getTime() >= start.getTime() && isWithinBusinessWindow({ now: candidate, timeZone: PROSPECT_TZ })) {
      return candidate;
    }
  }
  throw new Error('no open prospecting window within 8 days');
}

test('prospecting guards & scheduler: blocks opt-out and creates a preview for allowed leads', async () => {
  // Sunday in America/Fortaleza (2026-11-15T15:00:00Z is Sunday 12:00 BRT)
  const sundayNoon = new Date('2026-11-15T15:00:00.000Z');
  assert.equal(isWithinBusinessWindow({ now: sundayNoon, timeZone: PROSPECT_TZ }), false);

  // Monday 14:00 Fortaleza (2026-11-16T17:00:00Z) stays inside the window on any real clock.
  const mondayAfternoon = new Date('2026-11-16T17:00:00.000Z');
  assert.equal(isWithinBusinessWindow({ now: mondayAfternoon, timeZone: PROSPECT_TZ }), true);

  // Outside the window, the tick moves forward to the next open 14:00 (never a fixed date that expires).
  const saturdayNight = new Date('2026-11-14T22:30:00.000Z');
  const advanced = businessTickNow(saturdayNight);
  assert.ok(advanced.getTime() >= saturdayNight.getTime());
  assert.equal(advanced.toISOString(), '2026-11-16T17:00:00.000Z');
  assert.equal(isWithinBusinessWindow({ now: advanced, timeZone: PROSPECT_TZ }), true);
  const earlyMonday = new Date('2026-11-16T10:00:00.000Z');
  assert.equal(businessTickNow(earlyMonday).toISOString(), mondayAfternoon.toISOString());
  assert.equal(businessTickNow(mondayAfternoon).toISOString(), mondayAfternoon.toISOString());

  const leadStore = new ProspectLeadStore();
  const list = await leadStore.createList({ name: 'Lista Teste', status: 'active', dailyCap: 10 });
  await leadStore.addLeads(list.id, [
    { phone: '5585999991111', name: 'Ana' },
    { phone: '5585988882222', name: 'Bruno' }
  ]);
  const tickNow = businessTickNow(new Date());
  assert.equal(isWithinBusinessWindow({ now: tickNow, timeZone: PROSPECT_TZ }), true);

  const campaignStore = {
    isSuppressed: async phone => phone === '5585999991111'
  };
  const sent = [];
  const previews = [];
  const summary = await runProspectingTick({
    enabled: true,
    leadStore,
    campaignStore,
    send: async (phone, text) => { sent.push({ phone, text }); },
    stageOutboundDispatch: async (prepared, options) => { previews.push({ prepared, options }); return { id: 'P1R2O3S4' }; },
    now: tickNow,
    config: { timeZone: PROSPECT_TZ }
  });

  assert.equal(summary.sent, 0);
  assert.equal(summary.previewed, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(sent.length, 0, 'prospecção não envia antes da aprovação');
  assert.equal(previews.length, 1);
  assert.equal(previews[0].prepared.phone, '5585988882222');
  assert.match(previews[0].prepared.message, /Bruno/);
  assert.equal(previews[0].options.source, 'prospecting');

  // Fail-closed when suppression lookup throws
  const failingGuard = await evaluateProspectGuards({
    lead: { phone: '5585977773333' },
    now: tickNow,
    campaignStore: { isSuppressed: async () => { throw new Error('db_down'); } }
  });
  assert.equal(failingGuard.allowed, false);
  assert.equal(failingGuard.reason, 'suppression_check_failed');
});

import { createProspecting } from './prospecting/index.mjs';
import { handleProspectingRoutes } from './http/prospecting-routes.mjs';
import { Readable } from 'node:stream';

function mockReq(method, url, body = null) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function mockRes() {
  let status = 200;
  let body = '';
  return {
    writeHead(s) { status = s; },
    end(chunk = '') { body += chunk; },
    get result() { return { status, data: JSON.parse(body || '{}') }; }
  };
}

test('prospecting: ambiente não habilita nem configura execução sem snapshot ativo', () => {
  const previous = process.env.PROSPECTING_ENABLED;
  process.env.PROSPECTING_ENABLED = 'true';
  try {
    const prospecting = createProspecting({ sender: async () => {}, campaignStore: {} });
    assert.equal(prospecting.enabled, false);
  } finally {
    if (previous === undefined) delete process.env.PROSPECTING_ENABLED;
    else process.env.PROSPECTING_ENABLED = previous;
  }
});

test('prospecting routes & UI config: imports CSV, lists stats, toggles status, and reads adminConfig', async () => {
  const adminConfig = {
    active: {
      business: { hoursConfig: { timezone: 'America/Fortaleza' } },
      prospecting: { enabled: true, dailyCap: 15, warmupDays: 0, windowStart: '00:00', windowEnd: '23:59' }
    }
  };
  const prospecting = createProspecting({
    sender: async () => {},
    campaignStore: { isSuppressed: async () => false },
    adminConfig
  });
  assert.equal(prospecting.enabled, true);

  const createRes = mockRes();
  await handleProspectingRoutes({
    req: mockReq('POST', '/api/dashboard/prospecting/lists', {
      name: 'Clinicas Teste',
      segment: 'Odonto',
      leadsText: 'nome,telefone\nMaria,(85) 99999-4444'
    }),
    res: createRes,
    u: new URL('http://localhost/api/dashboard/prospecting/lists'),
    prospecting
  });
  assert.equal(createRes.result.status, 201);
  assert.equal(createRes.result.data.importedCount, 1);
  const listId = createRes.result.data.list.id;

  const statusRes = mockRes();
  await handleProspectingRoutes({
    req: mockReq('POST', `/api/dashboard/prospecting/lists/${listId}/status`, { status: 'active' }),
    res: statusRes,
    u: new URL(`http://localhost/api/dashboard/prospecting/lists/${listId}/status`),
    prospecting
  });
  assert.equal(statusRes.result.status, 200);
  assert.equal(statusRes.result.data.list.status, 'active');

  const listRes = mockRes();
  await handleProspectingRoutes({
    req: mockReq('GET', '/api/dashboard/prospecting/lists'),
    res: listRes,
    u: new URL('http://localhost/api/dashboard/prospecting/lists'),
    prospecting
  });
  assert.equal(listRes.result.status, 200);
  assert.equal(listRes.result.data.lists[0].stats.total, 1);
});
