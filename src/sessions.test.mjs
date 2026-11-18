import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, normalizePhone, mask } from './sessions.mjs';
import { SupabaseSessionStore } from './supabase-runtime.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';

test('normalizePhone e mask formatam numeros brasileiros corretamente', () => {
  assert.equal(normalizePhone('+55 (11) 99999-8888'), '5511999998888');
  assert.equal(normalizePhone('sim:5511999998888'), 'sim:5511999998888');
  assert.equal(mask('5511999998888'), '551***88');
});

test('SessionStore cria, persiste e recarrega sessao com flush()', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-sessions-'));
  const file = path.join(dir, 'sessions.json');
  const store = new SessionStore(file, { now: () => 1700000000000 });
  await store.load();
  const s = store.get('5511999998888');
  s.history.push({ role: 'user', content: 'oi' });
  store.touch(s);
  await store.flush();

  const store2 = new SessionStore(file, { now: () => 1700000000000 });
  await store2.load();
  assert.equal(store2.get('5511999998888').history.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('SessionStore.flush() loga e propaga erro de gravacao em disco', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-sessions-err-'));
  // Aponta file para um diretório existente para forçar erro no rename/writeFile
  const badFile = dir;
  const errors = [];
  const store = new SessionStore(badFile, {
    logger: { error: (...args) => errors.push(args.join(' ')) }
  });
  store.get('5511999998888');
  await assert.rejects(() => store.flush());
  assert.ok(errors.some((e) => e.includes('falha de gravação')));
  await fs.rm(dir, { recursive: true, force: true });
});

test('SessionStore.purge() remove sessoes expiradas sem legalHold', () => {
  const now = 1700000000000;
  const store = new SessionStore(path.join(os.tmpdir(), 'unused.json'), {
    now: () => now,
    ttlMs: 1000
  });
  store.sessions['5511999998888'] = { phone: '5511999998888', updatedAt: new Date(now - 5000).toISOString() };
  store.sessions['5511999997777'] = { phone: '5511999997777', legalHold: true, updatedAt: new Date(now - 5000).toISOString() };
  const removed = store.purge();
  assert.equal(removed, 1);
  assert.equal(store.sessions['5511999998888'], undefined);
  assert.ok(store.sessions['5511999997777']);
});

test('SupabaseSessionStore persiste e restaura pendingPixRequest pelo metadata da conversa', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-pending-pix-'));
  let conversationRow = null;
  const fakeClient = {
    enabled: true,
    async select(table, query) {
      if (table === 'conversations') {
        if (query.includes('status=eq.archived')) return [];
        return conversationRow ? [conversationRow] : [];
      }
      if (table === 'conversation_messages') return [];
      return [];
    },
    async upsert(table, rows) {
      if (table === 'contacts') return [{ id: 'contact-1' }];
      if (table === 'conversations') {
        conversationRow = {
          ...rows[0],
          id: 'conversation-1',
          updated_at: new Date().toISOString(),
          contacts: { phone: '5511999998888' }
        };
        return [{ id: 'conversation-1' }];
      }
      return [];
    }
  };
  const pending = { requestedAt: '2026-11-18T15:34:56.000Z' };
  const store = new SupabaseSessionStore(path.join(dir, 'sessions.json'), { client: fakeClient });
  const session = store.get('5511999998888');
  session.pendingPixRequest = pending;
  session.updatedAt = pending.requestedAt;
  session.lastUserAt = pending.requestedAt;
  store.markDirty();
  await store.flush();

  assert.deepEqual(conversationRow.metadata.pendingPixRequest, pending);
  const restoredStore = new SupabaseSessionStore(path.join(dir, 'sessions-restored.json'), { client: fakeClient });
  const restored = await restoredStore.syncSession('5511999998888');
  assert.deepEqual(restored.pendingPixRequest, pending);
  await fs.rm(dir, { recursive: true, force: true });
});

test('SupabaseSessionStore persiste e restaura pendingClientPayment entre processos', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-pending-client-payment-'));
  let conversationRow = null;
  const fakeClient = {
    enabled: true,
    async select(table, query = '') {
      if (table === 'conversations') {
        if (query.includes('status=eq.archived')) return [];
        return conversationRow ? [conversationRow] : [];
      }
      if (table === 'conversation_messages') return [];
      return [];
    },
    async upsert(table, rows) {
      if (table === 'contacts') return [{ id: 'contact-client-payment' }];
      if (table === 'conversations') {
        conversationRow = {
          ...rows[0],
          id: 'conversation-client-payment',
          updated_at: new Date().toISOString(),
          contacts: { phone: '5511987654321' }
        };
        return [{ id: 'conversation-client-payment' }];
      }
      return [];
    }
  };
  const pending = {
    args: { valor: 10, descricao: 'Consulta' },
    choice: 'pix',
    createdAt: new Date().toISOString()
  };
  const store = new SupabaseSessionStore(path.join(dir, 'sessions.json'), { client: fakeClient });
  const session = store.get('5511987654321');
  session.pendingClientPayment = pending;
  session.updatedAt = pending.createdAt;
  session.lastUserAt = pending.createdAt;
  store.markDirty();
  await store.flush();

  assert.deepEqual(conversationRow.metadata.pendingClientPayment, pending);
  const restoredStore = new SupabaseSessionStore(path.join(dir, 'sessions-restored.json'), { client: fakeClient });
  const restored = await restoredStore.syncSession('5511987654321');
  assert.deepEqual(restored.pendingClientPayment, pending);
  await fs.rm(dir, { recursive: true, force: true });
});

test('SupabaseSessionStore.syncSession preserva alterações locais pendentes, takeover recente e limpeza local', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-sync-session-'));
  const file = path.join(dir, 'sessions.json');
  const nowMs = Date.parse('2026-11-14T10:10:00.000Z');
  const fakeClient = {
    enabled: true,
    async select(table) {
      if (table === 'conversations') {
        return [{
          id: 'conv-1',
          external_key: '5511999998888',
          origin: 'real',
          mode: 'bot',
          updated_at: '2026-11-14T10:05:00.000Z',
          contacts: { display_name: 'Ana', push_name: 'Ana', phone: '5511999998888' }
        }];
      }
      if (table === 'conversation_messages') {
        return [{ conversation_id: 'conv-1', external_id: 'm1', role: 'user', content: 'oi antigo', created_at: '2026-11-14T10:04:00.000Z' }];
      }
      return [];
    }
  };

  const store = new SupabaseSessionStore(file, { client: fakeClient, now: () => nowMs });

  // 1. Sessão inexistente em memória carrega do remoto
  const loaded = await store.syncSession('5511999998888');
  assert.equal(loaded.human, false);
  assert.equal(loaded.history.length, 1);

  // 2. Takeover local com updatedAt mais recente que row.updated_at não é sobrescrito pelo remoto
  loaded.human = true;
  loaded.humanSource = 'takeover';
  loaded.lastUserAt = '2026-11-14T10:04:00.000Z';
  loaded.updatedAt = '2026-11-14T10:08:00.000Z';
  const afterTakeover = await store.syncSession('5511999998888');
  assert.equal(afterTakeover.human, true, 'não deve sobrescrever takeover mais recente por causa de lastUserAt antigo');

  // 3. Sessão limpa localmente (history: []) não ressuscita mensagens antigas nem quando saveTimer está pendente
  loaded.history = [];
  loaded.updatedAt = '2026-11-14T10:01:00.000Z';
  store.saveTimer = setTimeout(() => {}, 5000);
  const afterClear = await store.syncSession('5511999998888');
  assert.equal(afterClear.history.length, 0);
  clearTimeout(store.saveTimer);
  store.saveTimer = null;

  await fs.rm(dir, { recursive: true, force: true });
});

test('SupabaseSessionStore persiste e restaura pendingOutboundDispatch na sessão do Copilot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-pending-outbound-'));
  let conversationRow = null;
  const fakeClient = {
    enabled: true,
    async select(table, query = '') {
      if (table === 'conversations') {
        if (query.includes('status=eq.archived')) return [];
        return conversationRow ? [conversationRow] : [];
      }
      if (table === 'conversation_messages') return [];
      return [];
    },
    async upsert(table, rows) {
      if (table === 'contacts') return [{ id: 'contact-owner' }];
      if (table === 'conversations') {
        conversationRow = { ...rows[0], id: 'conv-owner', updated_at: rows[0].updated_at || new Date().toISOString(), contacts: { phone: null } };
        return [{ id: 'conv-owner' }];
      }
      return [];
    }
  };
  const pending = {
    id: 'A1B2C3D4', phone: '5511999998888', recipient: 'Ana', message: 'Oi, tudo bem?',
    source: 'copilot', status: 'pending', createdAt: '2026-11-18T15:00:00.000Z'
  };
  const store = new SupabaseSessionStore(path.join(dir, 'sessions.json'), { client: fakeClient });
  const session = store.get(OWNER_SELF_KEY);
  session.pendingOutboundDispatch = pending;
  session.updatedAt = pending.createdAt;
  store.markDirty();
  await store.flush();

  assert.deepEqual(conversationRow.metadata.pendingOutboundDispatch, pending);
  // Mutação do status da prévia deve persistir mesmo que updatedAt e histórico não mudem.
  session.pendingOutboundDispatch = { ...pending, status: 'sending' };
  await store.flush();
  assert.equal(conversationRow.metadata.pendingOutboundDispatch.status, 'sending');
  const restoredStore = new SupabaseSessionStore(path.join(dir, 'sessions-restored.json'), { client: fakeClient });
  const restored = await restoredStore.syncSession(OWNER_SELF_KEY);
  assert.deepEqual(restored.pendingOutboundDispatch, { ...pending, status: 'sending' });
  await fs.rm(dir, { recursive: true, force: true });
});
