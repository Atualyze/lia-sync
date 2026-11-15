-- Schema opcional para persistência de longo prazo + busca semântica (pgvector) no Supabase
-- Execute no SQL Editor do Supabase caso deseje habilitar busca vetorial remota além do cache local.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.lia_memories (
  id UUID PRIMARY KEY,
  scope_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('preference', 'project', 'decision', 'fact')),
  content TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.7,
  confidence REAL NOT NULL DEFAULT 0.85,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'forgotten')),
  source TEXT NOT NULL DEFAULT 'conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lia_memories_scope_status
  ON public.lia_memories (scope_key, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.lia_memory_embeddings (
  memory_id UUID PRIMARY KEY REFERENCES public.lia_memories(id) ON DELETE CASCADE,
  embedding vector(768) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.match_lia_memories(
  p_scope_key TEXT,
  p_query_embedding vector(768),
  p_match_count INT DEFAULT 6
)
RETURNS TABLE (
  id UUID,
  scope_key TEXT,
  type TEXT,
  content TEXT,
  importance REAL,
  confidence REAL,
  similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    m.id,
    m.scope_key,
    m.type,
    m.content,
    m.importance,
    m.confidence,
    1 - (e.embedding <=> p_query_embedding) AS similarity
  FROM public.lia_memories m
  JOIN public.lia_memory_embeddings e ON e.memory_id = m.id
  WHERE m.scope_key = p_scope_key
    AND m.status = 'active'
  ORDER BY (1 - (e.embedding <=> p_query_embedding)) * 0.7 + m.importance * 0.3 DESC
  LIMIT GREATEST(1, p_match_count);
$$;
