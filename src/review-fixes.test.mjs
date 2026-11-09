import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from './sessions.mjs';
import { ReminderStore } from './reminders.mjs';
import { toolAgendarRetorno } from './tools/agendar_retorno.mjs';
import { SupabaseSessionStore } from './supabase-runtime.mjs';

const quietLogger = { warn() {}, error() {} };

test('enqueue remove a fila em memória depois de terminar a execução', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `queue-${Date.now()}.json`), { logger: quietLogger });
  await Promise.all([store.enqueue('5588999990000', async () => 1), store.enqueue('5588999990000', async () => 2)]);
  assert.equal(store.queues.size, 0);
});

test('arquivos antigos de archive expiram, mas legal holds são preservados', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-retention-'));
  const now = Date.UTC(2026, 10, 9);
  const archive = path.join(dir, 'archive');
  await fs.mkdir(archive);
  const records = [
    ['expired.json', { archivedAt: new Date(now - 31 * 86400000).toISOString(), session: {} }],
    ['closed.json', { archivedAt: new Date(now - 31 * 86400000).toISOString(), session: { status: 'closed' } }],
    ['held.json', { archivedAt: new Date(now - 31 * 86400000).toISOString(), session: { metadata: { legal_hold: true } } }]
  ];
  for (const [name, record] of records) await fs.writeFile(path.join(archive, name), JSON.stringify(record));
  const store = new SessionStore(path.join(dir, 'sessions.json'), { now: () => now, ttlMs: 30 * 86400000, logger: quietLogger });
  await store.purgeArchives();
  assert.deepEqual((await fs.readdir(archive)).sort(), ['held.json']);
});

test('agendar_retorno usa ReminderStore.add e só confirma após persistência', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reminder-persist-'));
  const store = new ReminderStore(path.join(dir, 'reminders.json'), { logger: quietLogger });
  await store.load();
  const result = await toolAgendarRetorno.execute({ reason: 'Retornar ao cliente', when: '2026-11-10T15:00:00.000Z' }, {
    phone: '5588999990000', clientName: 'Contato teste', reminderStore: store
  });
  assert.equal(result.success, true);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'reminders.json'), 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].text, 'Retornar ao cliente');
  const failed = await toolAgendarRetorno.execute({ reason: 'Sem store', when: 'amanhã' }, { phone: '5588999990000' });
  assert.equal(failed.success, false);
});

test('falha de persistência local de reminder não produz confirmação positiva', async () => {
  const invalidDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reminder-fail-'));
  const blockingFile = path.join(invalidDir, 'blocking-file');
  await fs.writeFile(blockingFile, 'cannot-be-directory');
  const store = new ReminderStore(path.join(blockingFile, 'reminders.json'), { logger: quietLogger });
  await assert.rejects(() => store.add({ text: 'Teste', dueAt: '2026-11-10T15:00:00.000Z' }));
  const result = await toolAgendarRetorno.execute({ reason: 'Teste', when: '2026-11-10T15:00:00.000Z' }, {
    phone: '5588999990000', reminderStore: store
  });
  assert.equal(result.success, false);
  assert.doesNotMatch(result.message || '', /agendado com sucesso/i);
});

test('resposta clínica bloqueada é substituída antes de retornar e aciona handoff', async () => {
  const { createFlow } = await import('./flow.mjs');
  const store = new SessionStore(path.join(os.tmpdir(), `blocked-reply-${Date.now()}.json`), { logger: quietLogger });
  await store.load();
  const flow = createFlow({
    store,
    faq: async () => [],
    ai: { askAI: async () => ({ reply: 'Dê 5 mg de dipirona em casa.', intent: 'outro', collected: {} }) }
  });
  const reply = await flow.process({ phone: '5588999990000', text: 'Oi, preciso de ajuda', origin: 'simulation' });
  assert.doesNotMatch(reply, /5 mg|dipirona/i);
  assert.match(reply, /encaminhei|equipe/i);
  assert.equal(store.get('5588999990000', 'simulation').human, true);
});

test('Supabase deduplica apenas IDs repetidos e preserva mensagens idênticas com IDs diferentes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'supabase-dedupe-'));
  const client = {
    enabled: true,
    async select(table, query) {
      if (table === 'conversations' && query.includes('status=eq.archived')) return [];
      if (table === 'conversations') return [{ id: 'conversation-1', external_key: '5588999990000', status: 'open', contacts: {}, updated_at: '2026-11-09T12:00:00.000Z' }];
      if (table === 'conversation_messages') return [
        { conversation_id: 'conversation-1', external_id: 'wa:message-2', role: 'user', content: 'Oi de novo', created_at: '2026-11-09T11:01:00.000Z' },
        { conversation_id: 'conversation-1', external_id: 'wa:message-1', role: 'user', content: 'Oi de novo', created_at: '2026-11-09T11:00:00.000Z' },
        { conversation_id: 'conversation-1', external_id: 'wa:message-1', role: 'user', content: 'Oi de novo', created_at: '2026-11-09T11:00:00.000Z' }
      ];
      return [];
    },
    async request() { return null; }
  };
  const store = new SupabaseSessionStore(path.join(dir, 'sessions.json'), { client, logger: quietLogger });
  await store.load();
  assert.deepEqual(store.sessions['5588999990000'].history.map(m => m.id), ['wa:message-1', 'wa:message-2']);
});

test('retenção remota exclui apenas archives expirados sem legal hold', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'supabase-retention-'));
  const now = Date.UTC(2026, 10, 9);
  const deleted = [];
  const client = {
    enabled: true,
    async select(table, query) {
      if (table === 'conversations' && query.includes('status=eq.archived')) return [
        { id: 'expired', status: 'archived', metadata: {} },
        { id: 'legal-hold', status: 'archived', metadata: { legal_hold: true } },
        { id: 'closed', status: 'closed', metadata: {} }
      ];
      return [];
    },
    async request(table, options) { deleted.push({ table, ...options }); }
  };
  const store = new SupabaseSessionStore(path.join(dir, 'sessions.json'), { client, now: () => now, ttlMs: 30 * 86400000, logger: quietLogger });
  await store.purgeArchives();
  assert.equal(deleted.length, 1);
  assert.match(deleted[0].query, /expired/);
  assert.match(deleted[0].query, /metadata-%3E%3Elegal_hold=not.is.true/);
});
