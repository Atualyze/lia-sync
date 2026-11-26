-- Adiciona campos de contexto para a IA e CRM na tabela public.contacts (idempotente)
alter table if exists public.contacts
  add column if not exists ai_context text,
  add column if not exists email text,
  add column if not exists deal_value numeric(12,2) default 0,
  add column if not exists funnel_stage text default 'novo',
  add column if not exists sector_id text,
  add column if not exists tags text[] default '{}'::text[],
  add column if not exists metadata jsonb default '{}'::jsonb;
