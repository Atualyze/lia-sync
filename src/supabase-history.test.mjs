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
