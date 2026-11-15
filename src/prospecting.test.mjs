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

test('prospecting guards & scheduler: blocks outside business hours or suppressed, sends when allowed', async () => {
  // Sunday in America/Fortaleza (2026-11-15T15:00:00Z is Sunday 12:00 BRT)
  const sundayNoon = new Date('2026-11-15T15:00:00.000Z');
  assert.equal(isWithinBusinessWindow({ now: sundayNoon, timeZone: 'America/Fortaleza' }), false);

  // Monday 14:00 BRT (2026-11-16T17:00:00Z)
  const mondayAfternoon = new Date('2026-11-16T17:00:00.000Z');
  assert.equal(isWithinBusinessWindow({ now: mondayAfternoon, timeZone: 'America/Fortaleza' }), true);

  const leadStore = new ProspectLeadStore();
  const list = await leadStore.createList({ name: 'Lista Teste', status: 'active', dailyCap: 10 });
  await leadStore.addLeads(list.id, [
    { phone: '5585999991111', name: 'Ana' },
    { phone: '5585988882222', name: 'Bruno' }
  ]);

  const campaignStore = {
    isSuppressed: async phone => phone === '5585999991111'
  };
  const sent = [];
  const summary = await runProspectingTick({
    enabled: true,
    leadStore,
    campaignStore,
    send: async (phone, text) => { sent.push({ phone, text }); },
    now: mondayAfternoon,
    config: { timeZone: 'America/Fortaleza' }
  });

  assert.equal(summary.sent, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(sent[0].phone, '5585988882222');
  assert.match(sent[0].text, /Bruno/);

  // Fail-closed when suppression lookup throws
  const failingGuard = await evaluateProspectGuards({
    lead: { phone: '5585977773333' },
    now: mondayAfternoon,
    campaignStore: { isSuppressed: async () => { throw new Error('db_down'); } }
  });
  assert.equal(failingGuard.allowed, false);
  assert.equal(failingGuard.reason, 'suppression_check_failed');
});
