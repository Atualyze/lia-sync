import test from 'node:test';
import assert from 'node:assert/strict';
import { ProspectLeadStore } from './prospecting/lead-store.mjs';
import { handleInboundOptOut } from './prospecting/optout.mjs';
import { renderFallbackTemplate, runProspectingTick } from './prospecting/scheduler.mjs';

const NOW = new Date('2026-11-17T17:00:00.000Z');

const openCampaign = { isSuppressed: async () => false, addSuppression: async () => {} };

test('opt-out não intercepta mensagem de cliente com sessão ativa', async () => {
  let sent = 0;
  const result = await handleInboundOptOut({
    phone: '5585999991111', text: 'cancelar', campaignStore: openCampaign,
    prospectStore: { hasLeadByPhone: async () => false },
    sessionStore: { has: () => true, get: () => ({ history: [{ role: 'user' }] }) },
    send: async () => { sent += 1; }
  });
  assert.equal(result.matched, false);
  assert.equal(sent, 0);
});

test('scheduler cria prévia de prospecção e não envia ao lead antes da confirmação', async () => {
  const leadStore = {
    async listDueLeads() { return [{ id: 'l1', list_id: 'list', phone: '5585999991111', stage: 0, attempts: 0, list: { id: 'list', daily_cap: 10 } }]; },
    async claimLeadWithinCap() { return { claimed: { claim_token: 'token' } }; },
    async releaseClaim() { throw new Error('should_not_release_successful_preview'); },
    async countSentToday() { return 0; }
  };
  const sent = [];
  const previews = [];
  const summary = await runProspectingTick({
    enabled: true, leadStore, campaignStore: openCampaign, now: NOW,
    send: async (...args) => sent.push(args),
    stageOutboundDispatch: async (prepared, options) => { previews.push({ prepared, options }); return { id: 'A1B2C3D4' }; },
    config: { timeZone: 'America/Fortaleza', minDelayMs: 0, maxDelayMs: 0 }
  });
  assert.equal(summary.sent, 0);
  assert.equal(summary.previewed, 1);
  assert.equal(sent.length, 0);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].options.source, 'prospecting');
  assert.equal(summary.failed, 0);
  assert.equal(summary.persistenceErrors, 0);
});

test('falha ao criar prévia devolve lead à fila e não envia', async () => {
  const leadStore = new ProspectLeadStore();
  const list = await leadStore.createList({ name: 'Retry', status: 'active', dailyCap: 10 });
  const [lead] = await leadStore.addLeads(list.id, [{ phone: '5585999992222', name: 'Bia' }]);
  // O lead é criado com o relógio real; alinhe-o ao relógio simulado do teste
  // para que ele esteja vencido e entre na fila de forma determinística.
  leadStore.mem.leads.get(lead.id).next_action_at = NOW.toISOString();
  const sent = [];
  const summary = await runProspectingTick({ enabled: true, leadStore, campaignStore: openCampaign, now: NOW, send: async (...args) => sent.push(args), stageOutboundDispatch: async () => { throw new Error('preview_failed'); }, config: { timeZone: 'America/Fortaleza', minDelayMs: 0, maxDelayMs: 0, retryBaseMinutes: 15, maxAttempts: 3 } });
  assert.equal(summary.failed, 1);
  assert.equal(sent.length, 0);
  assert.equal(leadStore.mem.leads.get(lead.id).status, 'queued');
  assert.ok(leadStore.mem.leads.get(lead.id).next_action_at);
});

test('template não inventa nome nem duplica saudação', () => {
  assert.equal(renderFallbackTemplate('Olá {{nome}}, tudo bem? {{empresa}}', { name: '', context: {} }), 'Olá, tudo bem?');
});
