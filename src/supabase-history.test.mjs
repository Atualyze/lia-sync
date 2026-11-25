import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { SupabaseSessionStore } from './supabase-runtime.mjs';

test('SupabaseSessionStore busca conversas anteriores do mesmo contato sob demanda', async () => {
  const calls = [];
  const client = {
    enabled: true,
    async select(table, query) {
      calls.push({ table, query });
      if (table === 'conversations') {
        return [
          { id: 'conversation-current', status: 'open' },
          { id: 'conversation-older', status: 'closed' }
        ];
      }
      if (table === 'conversation_messages') {
        return [
          {
            conversation_id: 'conversation-current',
            external_id: 'wa:current-1',
            role: 'user',
            content: 'Quero o Pix copia e cola',
            created_at: '2026-11-19T16:28:00.000Z'
          },
          {
            conversation_id: 'conversation-older',
            external_id: 'wa:old-1',
            role: 'user',
            content: 'Quero criar um site para minha oficina',
            created_at: '2026-11-10T12:00:00.000Z'
          },
          {
            conversation_id: 'conversation-older',
            external_id: 'wa:old-2',
            role: 'assistant',
            content: 'Podemos estruturar um painel para acompanhar os serviços',
            created_at: '2026-11-10T12:01:00.000Z'
          }
        ];
      }
      return [];
    }
  };
  const store = new SupabaseSessionStore(
    path.join(os.tmpdir(), `lia-history-${Date.now()}.json`),
    { client, logger: { warn() {} } }
  );

  const history = await store.searchContactConversationHistory({
    _contactId: 'contact-123',
    _conversationId: 'conversation-current'
  });

  assert.equal(history.length, 3);
  assert.ok(history.some(message => message.conversationId === 'conversation-older'));
  assert.match(calls[0].query, /contact_id=eq\.contact-123/);
  assert.match(calls[1].query, /conversation_id=in\./);
  assert.equal(history[0].conversationId, 'conversation-older');
});

test('SupabaseSessionStore não tenta buscar histórico remoto sem cliente ou contato', async () => {
  const store = new SupabaseSessionStore(
    path.join(os.tmpdir(), `lia-history-offline-${Date.now()}.json`),
    { client: { enabled: false } }
  );

  assert.deepEqual(await store.searchContactConversationHistory({ _contactId: 'contact-123' }), []);
  assert.deepEqual(await store.searchContactConversationHistory({ _contactId: null }), []);
});


test('refresh autoritativo de Pix falha fechado quando o Supabase não responde', async () => {
  const store = new SupabaseSessionStore(
    path.join(os.tmpdir(), `lia-pix-refresh-failure-${Date.now()}.json`),
    {
      client: {
        enabled: true,
        async select() { throw new Error('supabase_unavailable'); }
      },
      logger: { warn() {} }
    }
  );

  await assert.rejects(
    store.refresh({ force: true, requireRemote: true }),
    /supabase_unavailable/
  );
  assert.match(store.remoteError, /supabase_unavailable/);
});

test('SupabaseSessionStore persiste e restaura uma decisão administrativa de Pix', async () => {
  let conversationRow = null;
  const client = {
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
      if (table === 'contacts') return [{ id: 'contact-admin-pix' }];
      if (table === 'conversations') {
        conversationRow = {
          ...rows[0],
          id: 'conversation-admin-pix',
          updated_at: new Date().toISOString(),
          contacts: { phone: rows[0].external_key }
        };
        return [{ id: 'conversation-admin-pix' }];
      }
      return [];
    }
  };
  const file = path.join(os.tmpdir(), `lia-admin-pix-${Date.now()}.json`);
  const requestedAt = new Date().toISOString();
  const pending = {
    type: 'pix_generation',
    status: 'pending',
    requestId: '7b32ce21-6f63-4f36-b4ac-93b5a319fd65',
    amount: 5,
    description: 'Pagamento via Pix',
    paymentMethod: 'pix_copy_paste',
    requestedAt
  };
  const store = new SupabaseSessionStore(file, { client, logger: { warn() {} } });
  const session = store.get('5588999991111');
  session.clientName = 'Ana';
  session.pendingAdminDecision = pending;
  session.updatedAt = requestedAt;
  store.markDirty();
  await store.flush();

  assert.deepEqual(conversationRow.metadata.pendingAdminDecision, pending);
  const restoredStore = new SupabaseSessionStore(
    path.join(os.tmpdir(), `lia-admin-pix-restored-${Date.now()}.json`),
    { client, logger: { warn() {} } }
  );
  const restored = await restoredStore.syncSession('5588999991111');
  assert.deepEqual(restored.pendingAdminDecision, pending);
});


test('flush remoto envia apenas mensagens novas e ignora payloads sem alteração', async () => {
  const writes = [];
  const client = {
    enabled: true,
    async upsert(table, rows, onConflict, options = {}) {
      writes.push({ table, rows: structuredClone(rows), onConflict, options });
      if (table === 'contacts') return [{ id: 'contact-write-optimization' }];
      if (table === 'conversations') return [{ id: 'conversation-write-optimization' }];
      return [];
    },
    async select() { return []; }
  };
  const store = new SupabaseSessionStore(
    path.join(os.tmpdir(), `lia-write-optimization-${Date.now()}.json`),
    { client, logger: { warn() {} } }
  );
  const session = store.get('5511999990000');
  session.clientName = 'Ana';
  session.lastUserAt = '2026-11-25T12:00:00.000Z';
  session.updatedAt = session.lastUserAt;
  session.history.push({
    id: 'wa:message-1',
    role: 'user',
    content: 'Olá',
    createdAt: session.lastUserAt
  });
  store.markDirty();
  await store.flush();

  assert.equal(writes.filter(item => item.table === 'contacts').length, 1);
  assert.equal(writes.filter(item => item.table === 'conversations').length, 1);
  assert.equal(writes.filter(item => item.table === 'conversation_messages').length, 1);
  assert.equal(writes.find(item => item.table === 'conversation_messages').rows.length, 1);

  writes.length = 0;
  await store.flush();
  assert.equal(writes.length, 0, 'flush sem alterações não deve fazer chamadas REST');

  session.history.push({
    id: 'wa:message-2',
    role: 'assistant',
    content: 'Olá, como posso ajudar?',
    createdAt: '2026-11-25T12:00:05.000Z'
  });
  session.lastBotAt = '2026-11-25T12:00:05.000Z';
  session.updatedAt = session.lastBotAt;
  store.markDirty();
  await store.flush();

  const messageWrite = writes.find(item => item.table === 'conversation_messages');
  assert.ok(messageWrite);
  assert.equal(messageWrite.rows.length, 1, 'deve enviar apenas a mensagem nova');
  assert.equal(messageWrite.rows[0].external_id, 'wa:message-2');
  assert.equal(writes.filter(item => item.table === 'contacts').length, 0, 'last_seen_at não muda em resposta do bot');
  assert.equal(writes.filter(item => item.table === 'conversations').length, 1, 'a conversa muda com a nova resposta');
});
