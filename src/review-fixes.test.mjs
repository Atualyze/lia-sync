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
  const futureIso = new Date(Date.now() + 86400000).toISOString();
  const result = await toolAgendarRetorno.execute({ reason: 'Retornar ao cliente', when: futureIso }, {
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


test('retenção limita idempotency keys, telemetria de IA e ledger de webhook', async () => {
  const deleted = [];
  const uuid = '11111111-1111-4111-8111-111111111111';
  const webhookKey = 'a'.repeat(64);
  const client = {
    enabled: true,
    async select(table) {
      if (table === 'idempotency_keys') return [{ id: uuid }];
      if (table === 'ai_calls') return [{ id: uuid }];
      if (table === 'webhook_events') return [{ event_key: webhookKey }];
      return [];
    },
    async request(table, options) { deleted.push({ table, ...options }); }
  };
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const store = new SupabaseSessionStore(
    path.join(os.tmpdir(), `supabase-retention-telemetry-${Date.now()}.json`),
    { client, now: () => now, ttlMs: 30 * 86400000, logger: quietLogger }
  );

  await store.purgeArchives();

  assert.deepEqual(deleted.map(item => item.table).sort(), [
    'ai_calls',
    'idempotency_keys',
    'webhook_events'
  ]);
  const aiDelete = deleted.find(item => item.table === 'ai_calls');
  const webhookDelete = deleted.find(item => item.table === 'webhook_events');
  assert.match(aiDelete.query, /id=in\./);
  assert.match(webhookDelete.query, /event_key=in\./);
});


test('consultas de lembrete listam, contam e confirmam apenas registros do telefone autenticado', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reminder-self-query-'));
  const store = new ReminderStore(path.join(dir, 'reminders.json'), { logger: quietLogger });
  await store.load();
  const dueA = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const dueB = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
  await store.add({ phone: '5588998340085', text: 'Reunião com Tauan', dueAt: dueA, clientName: 'Contato A' });
  await store.add({ phone: '5588998340085', text: 'Comprar ração', dueAt: dueB, clientName: 'Contato A' });
  await store.add({ phone: '5588998340086', text: 'Informação privada de outro contato', dueAt: dueA, clientName: 'Contato B' });

  const context = { actor: 'client', phone: '5588998340085', reminderStore: store };
  const count = await toolAgendarRetorno.execute({ action: 'contar' }, context);
  assert.equal(count.success, true);
  assert.equal(count.count, 2);

  const list = await toolAgendarRetorno.execute({ action: 'listar', phone: '5588998340086' }, context);
  assert.equal(list.success, true);
  assert.equal(list.count, 2);
  assert.deepEqual(list.reminders.map(item => item.text).sort(), ['Comprar ração', 'Reunião com Tauan']);
  assert.doesNotMatch(JSON.stringify(list), /Informação privada de outro contato|5588998340086/);

  const latest = await toolAgendarRetorno.execute({ action: 'ultimo' }, context);
  assert.equal(latest.success, true);
  assert.equal(latest.reminder.text, 'Comprar ração');

  const denied = await toolAgendarRetorno.execute({ action: 'listar' }, {
    actor: 'owner', phone: '5588998340085', reminderStore: store
  });
  assert.equal(denied.success, false);
  assert.equal(denied.error, 'reminder_query_client_scope_only');

  const invalidSession = await toolAgendarRetorno.execute({ action: 'listar' }, {
    actor: 'client', phone: '', reminderStore: store
  });
  assert.equal(invalidSession.success, false);
  assert.equal(invalidSession.error, 'invalid_authenticated_contact');

  await fs.rm(dir, { recursive: true, force: true });
});


test('lembretes não consultam nem gravam registros em sessões de simulação', async () => {
  const calls = [];
  const reminderStore = {
    async add(item) { calls.push({ type: 'add', item }); return { id: 'reminder-1' }; },
    listActiveForPhone(phone) { calls.push({ type: 'list', phone }); return []; }
  };
  const query = await toolAgendarRetorno.execute({ action: 'listar' }, {
    actor: 'client',
    phone: 'sim:5588998340085',
    origin: 'simulation',
    reminderStore
  });
  const create = await toolAgendarRetorno.execute({
    reason: 'Teste',
    when: new Date(Date.now() + 86400000).toISOString()
  }, {
    actor: 'client',
    phone: 'sim:5588998340085',
    origin: 'simulation',
    reminderStore
  });
  assert.equal(query.success, false);
  assert.equal(create.success, false);
  assert.deepEqual(calls, []);
});
