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

test('falha de persistência depois do envio não transforma sucesso em failed', async () => {
  const leadStore = {
    async listDueLeads() { return [{ id: 'l1', list_id: 'list', phone: '5585999991111', stage: 0, attempts: 0, list: { id: 'list', daily_cap: 10 } }]; },
    async claimLeadWithinCap() { return { claimed: { claim_token: 'token' } }; },
    async releaseClaim() { throw new Error('db_down'); },
    async recordEvent() { throw new Error('db_down'); },
    async countSentToday() { return 0; }
  };
  const summary = await runProspectingTick({ enabled: true, leadStore, campaignStore: openCampaign, now: NOW, send: async () => {}, config: { timeZone: 'America/Fortaleza', minDelayMs: 0, maxDelayMs: 0 } });
  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.persistenceErrors, 2);
});

test('falha transitória volta para a fila com backoff', async () => {
  const leadStore = new ProspectLeadStore();
  const list = await leadStore.createList({ name: 'Retry', status: 'active', dailyCap: 10 });
  const [lead] = await leadStore.addLeads(list.id, [{ phone: '5585999992222', name: 'Bia' }]);
  const summary = await runProspectingTick({ enabled: true, leadStore, campaignStore: openCampaign, now: NOW, send: async () => { throw new Error('timeout'); }, config: { timeZone: 'America/Fortaleza', minDelayMs: 0, maxDelayMs: 0, retryBaseMinutes: 15, maxAttempts: 3 } });
  assert.equal(summary.failed, 1);
  assert.equal(leadStore.mem.leads.get(lead.id).status, 'queued');
  assert.ok(leadStore.mem.leads.get(lead.id).next_action_at);
});

test('template não inventa nome nem duplica saudação', () => {
  assert.equal(renderFallbackTemplate('Olá {{nome}}, tudo bem? {{empresa}}', { name: '', context: {} }), 'Olá, tudo bem?');
});
