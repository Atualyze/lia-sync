import test from 'node:test';
import assert from 'node:assert/strict';
import { CampaignStore } from './campaigns.mjs';

function fakeClient() {
  const rows = { campaigns: [], campaign_recipients: [], idempotency_keys: [], phone_suppressions: [] };
  const filters = (table, query) => {
    let out = rows[table] || [];
    for (const field of ['id', 'campaign_id', 'phone', 'scope', 'key']) {
      const match = query.match(new RegExp(`(?:^|&)${field}=eq\\.([^&]+)`));
      if (match) out = out.filter(row => String(row[field]) === decodeURIComponent(match[1]));
    }
    const statuses = query.match(/(?:^|&)status=in\.\(([^)]+)\)/);
    if (statuses) out = out.filter(row => statuses[1].split(',').includes(String(row.status)));
    const status = query.match(/(?:^|&)status=eq\.([^&]+)/);
    if (status) out = out.filter(row => String(row.status) === decodeURIComponent(status[1]));
    const cutoff = query.match(/(?:^|&)updated_at=lt\.([^&]+)/);
    if (cutoff) out = out.filter(row => !row.updated_at || new Date(row.updated_at) < new Date(decodeURIComponent(cutoff[1])));
    const inIds = query.match(/(?:^|&)campaign_id=in\.\(([^)]+)\)/);
    if (inIds) out = out.filter(row => inIds[1].split(',').includes(row.campaign_id));
    return out;
  };
  return {
    enabled: true,
    rows,
    async insert(table, body) {
      const incoming = Array.isArray(body) ? body : [body];
      if (table === 'idempotency_keys' && incoming.some(item => rows[table].some(old => old.scope === item.scope && old.key === item.key))) throw new Error('duplicate key value violates unique constraint');
      rows[table].push(...incoming.map(item => ({ ...item })));
    },
    async upsert(table, body, conflict) {
      const incoming = Array.isArray(body) ? body : [body];
      for (const item of incoming) {
        const found = rows[table].find(row => row[conflict] === item[conflict]);
        if (found) Object.assign(found, item); else rows[table].push({ ...item });
      }
      return incoming.map(item => rows[table].find(row => row[conflict] === item[conflict]));
    },
    async select(table, query) { return [...filters(table, query)]; },
    async request(table, { method, query = '', body, prefer = '' }) {
      if (method === 'DELETE') {
        const matched = filters(table, query);
        rows[table] = rows[table].filter(row => !matched.includes(row));
        return null;
      }
      if (method === 'PATCH') {
        const matched = filters(table, query);
        matched.forEach(row => Object.assign(row, body));
        return prefer.includes('representation') ? matched.map(row => ({ ...row })) : null;
      }
      if (method === 'POST') {
        // Semântica PostgREST `resolution=ignore-duplicates,return=representation`:
        // conflito de chave única devolve linha vazia (sem inserir).
        const incoming = Array.isArray(body) ? body : [body];
        const inserted = [];
        for (const item of incoming) {
          if (table === 'idempotency_keys' && rows[table].some(old => old.scope === item.scope && old.key === item.key)) continue;
          const row = { ...item };
          rows[table].push(row);
          inserted.push(row);
        }
        return prefer.includes('representation') ? inserted.map(row => ({ ...row })) : null;
      }
      return null;
    }
  };
}

test('cria campanha idempotente e não envia do cliente', async () => {
  const client = fakeClient();
  const store = new CampaignStore({ client, sender: async () => {} });
  const a = await store.create({ title: 'Teste', message: 'Oi {{nome}}', recipients: [{ phone: '5511999999999', name: 'Ana' }], idempotencyKey: 'k1' });
  const b = await store.create({ title: 'Outro', message: 'Outro', recipients: [{ phone: '5511888888888' }], idempotencyKey: 'k1' });
  assert.equal(a.id, b.id);
  assert.equal(client.rows.campaigns.length, 1);
  assert.equal(client.rows.campaign_recipients[0].status, 'pending');
});

test('marca falha real do provedor e não falso sucesso', async () => {
  const client = fakeClient();
  const store = new CampaignStore({ client, sender: async () => { throw Object.assign(new Error('offline'), { code: 'provider_unavailable' }); }, maxPerRun: 1, delay: async () => {} });
  const campaign = await store.create({ title: 'Teste', message: 'Oi', recipients: [{ phone: '5511999999999' }] });
  const result = await store.execute(campaign.id);
  assert.equal(result.failedCount, 1);
  assert.equal(result.sentCount, 0);
  assert.equal(result.recipients[0].status, 'FAILED');
  assert.equal(result.recipients[0].attempts, 1);
});

test('suprime opt-out antes de chamar o provedor e permite gestão de supressão', async () => {
  const client = fakeClient();
  const store = new CampaignStore({ client, sender: async () => { throw new Error('não deve enviar'); }, maxPerRun: 1, delay: async () => {} });
  await store.addSuppression({ phone: '5511999999999', reason: 'Solicitação de opt-out' });
  let sends = 0;
  store.sender = async () => { sends++; };
  const campaign = await store.create({ title: 'Teste', message: 'Oi', recipients: [{ phone: '5511999999999' }] });
  const result = await store.execute(campaign.id);
  assert.equal(sends, 0);
  assert.equal(result.suppressedCount, 1);
  assert.equal(result.recipients[0].status, 'SUPPRESSED');
  assert.equal((await store.listSuppressions()).length, 1);
  await store.removeSuppression('5511999999999');
  assert.equal((await store.listSuppressions()).length, 0);
  await assert.rejects(() => store.addSuppression({ phone: '5511999999999', reason: 'contato João pediu' }), { code: 'invalid_suppression_reason' });
});

test('workers concorrentes reivindicam uma campanha pendente apenas uma vez', async () => {
  const client = fakeClient();
  let sends = 0;
  const store = new CampaignStore({ client, sender: async () => { sends++; }, maxPerRun: 1, delay: async () => {} });
  const campaign = await store.create({ title: 'Única', message: 'Oi', recipients: [{ phone: '5511999999999' }] });
  const results = await Promise.all([store.execute(campaign.id), store.execute(campaign.id)]);
  assert.equal(sends, 1);
  assert.equal(results.filter(result => result?.status === 'completed').length, 1);
  assert.ok(results.every(result => ['running', 'completed'].includes(result?.status)));
  assert.equal(client.rows.campaign_recipients[0].attempt_count, 1);
});
