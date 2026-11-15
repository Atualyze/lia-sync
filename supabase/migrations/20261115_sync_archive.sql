-- Soft delete / arquivo morto para sincronização bidirecional com WhatsApp.
-- Registros com deleted_at preenchido ficam ocultos nos painéis (LiaSync e LiaSync CRM),
-- mas permanecem preservados no banco para consulta direta.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_source TEXT;

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_source TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_active_not_deleted
  ON conversations (updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_messages_active_not_deleted
  ON conversation_messages (conversation_id, created_at DESC)
  WHERE deleted_at IS NULL;
