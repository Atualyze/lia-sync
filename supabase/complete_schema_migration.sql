-- ==============================================================================
-- LIA - ASSISTENTE DE ATENDIMENTO MULTICLIENTE
-- ESQUEMA DE MIGRAÇÃO DEFINITIVO SUPABASE (PostgreSQL)
-- ==============================================================================
-- Execute este script completo no painel do Supabase:
-- SQL Editor -> New Query -> Colar -> Run
-- ==============================================================================

begin;

-- 1. Extensões
create extension if not exists pgcrypto;

-- 2. Função utilitária para atualização automática de updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ==============================================================================
-- 3. PERFIS DE USUÁRIOS (Responsáveis e Administradores)
-- (Criada antes de is_active_staff para evitar erro de relação inexistente)
-- ==============================================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'admin' check (role in ('admin', 'operator', 'viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_active_role_idx on public.profiles (active, role);

-- 4. Função para verificar permissões de staff/operador no painel
create or replace function public.is_active_staff(required_roles text[] default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active = true
      and (required_roles is null or p.role = any(required_roles))
  );
end;
$$;

grant execute on function public.is_active_staff(text[]) to authenticated;

-- ==============================================================================
-- 5. CONTATOS (Pessoas / Clientes que conversam com a equipe)
-- ==============================================================================
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'other')),
  external_id text not null,
  phone text,
  display_name text,
  push_name text,
  notes text,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, external_id)
);

create index if not exists contacts_phone_idx on public.contacts (phone);
create index if not exists contacts_last_seen_idx on public.contacts (last_seen_at desc);

-- ==============================================================================
-- 6. CONVERSAS (Sessões gerenciadas pela Lia)
-- ==============================================================================
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts(id) on delete set null,
  external_key text not null unique,
  origin text not null default 'real' check (origin in ('real', 'simulation')),
  status text not null default 'open' check (status in ('open', 'archived', 'closed')),
  mode text not null default 'bot' check (mode in ('bot', 'human')),
  human_source text check (human_source in ('takeover', 'dashboard', 'resume', 'admin', 'auto-resume') or human_source is null),
  contact_name text,
  last_intent text,
  intents text[] not null default '{}',
  awaiting_reply boolean not null default false,
  inactivity_stage integer not null default 0 check (inactivity_stage >= 0 and inactivity_stage <= 3),
  inactivity_closed boolean not null default false,
  send_failed boolean not null default false,
  violations_count integer not null default 0 check (violations_count >= 0),
  fallback_handoff_at timestamptz,
  handoff_at timestamptz,
  handoff_reason text,
  handoff_urgency text check (handoff_urgency in ('normal', 'urgente') or handoff_urgency is null),
  handoff_notified boolean not null default false,
  handoff_notify_failed boolean not null default false,
  handoff_reminder_at timestamptz,
  handoff_reminder1_sent boolean not null default false,
  handoff_reminder60_sent boolean not null default false,
  last_user_at timestamptz,
  last_bot_at timestamptz,
  archived_at timestamptz,
  archive_reason text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_contact_idx on public.conversations (contact_id);
create index if not exists conversations_status_updated_idx on public.conversations (status, updated_at desc);
create index if not exists conversations_handoff_idx on public.conversations (mode, handoff_reminder_at) where mode = 'human';

-- ==============================================================================
-- 7. MENSAGENS (Histórico de texto, áudios transcritos e anexos)
-- ==============================================================================
create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  external_id text,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  message_type text not null default 'text' check (message_type in ('text', 'image', 'audio', 'video', 'document', 'location', 'sticker', 'other')),
  from_me boolean not null default false,
  delivery_status text not null default 'received' check (delivery_status in ('received', 'queued', 'sent', 'delivered', 'failed')),
  provider text,
  model text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (conversation_id, external_id)
);

create index if not exists conversation_messages_conversation_idx on public.conversation_messages (conversation_id, created_at);
create index if not exists conversation_messages_external_idx on public.conversation_messages (external_id) where external_id is not null;

-- ==============================================================================
-- 8. LEMBRETES E AGENDAMENTOS (Para o responsável)
-- ==============================================================================
create table if not exists public.reminders (
  id text primary key,
  text text not null,
  due_at timestamptz not null,
  phone text,
  client_name text,
  created_by text not null default 'tauan' check (created_by in ('tauan', 'contato', 'sistema')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'cancelled')),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists reminders_due_status_idx on public.reminders (status, due_at);

-- ==============================================================================
-- 9. HANDOFFS (Transferências diretas para o responsável)
-- ==============================================================================
create table if not exists public.handoffs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  reason text not null,
  urgency text not null default 'normal' check (urgency in ('normal', 'urgente')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'cancelled')),
  assigned_to uuid references public.profiles(id) on delete set null,
  notified_at timestamptz,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists handoffs_open_idx on public.handoffs (status, created_at desc) where status in ('open', 'acknowledged');

-- ==============================================================================
-- 10. EVENTOS E AUDITORIA DE CONVERSAS
-- ==============================================================================
create table if not exists public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  event_type text not null,
  actor_type text not null default 'system' check (actor_type in ('system', 'bot', 'human', 'dashboard', 'webhook')),
  actor_profile_id uuid references public.profiles(id) on delete set null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists conversation_events_conversation_idx on public.conversation_events (conversation_id, created_at desc);

-- ==============================================================================
-- 11. CONFIGURAÇÃO REMOTA DA LIA (Prompt, Identidade e Revisões)
-- ==============================================================================
create table if not exists public.bot_config_state (
  id boolean primary key default true check (id),
  revision integer not null default 0 check (revision >= 0),
  active_config jsonb not null default '{}'::jsonb check (jsonb_typeof(active_config) = 'object'),
  draft_config jsonb not null default '{}'::jsonb check (jsonb_typeof(draft_config) = 'object'),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bot_config_revisions (
  id uuid primary key default gen_random_uuid(),
  revision integer not null,
  action text not null check (action in ('published', 'rollback', 'draft_updated')),
  actor uuid references public.profiles(id) on delete set null,
  source_revision integer,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now(),
  unique (revision, action)
);

create index if not exists bot_config_revisions_created_idx on public.bot_config_revisions (created_at desc);

-- ==============================================================================
-- 12. TELEMETRIA E MÉTRICAS DE IA (Chamadas de Gemini e OpenRouter)
-- ==============================================================================
create table if not exists public.ai_calls (
  id uuid primary key default gen_random_uuid(),
  request_id text,
  conversation_id uuid references public.conversations(id) on delete set null,
  provider text not null,
  model text,
  latency_ms integer not null default 0 check (latency_ms >= 0),
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  total_tokens integer not null default 0 check (total_tokens >= 0),
  intent text,
  success boolean not null default true,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists ai_calls_created_idx on public.ai_calls (created_at desc);
create index if not exists ai_calls_provider_idx on public.ai_calls (provider, created_at desc);

-- ==============================================================================
-- 13. FAQ / BASE DE CONHECIMENTO DA LIA
-- ==============================================================================
create table if not exists public.faq (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug = lower(slug) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  question text not null,
  keys text[] not null default '{}',
  answer text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists faq_active_order_idx on public.faq (active, sort_order, created_at);

create table if not exists public.workspace_settings (
  id boolean primary key default true check (id),
  aeo_faq jsonb not null default '[]'::jsonb check (jsonb_typeof(aeo_faq) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ==============================================================================
-- 14. LOG DE AUDITORIA DO PAINEL
-- ==============================================================================
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

-- ==============================================================================
-- TRIGGERS DE ATUALIZAÇÃO AUTOMÁTICA
-- ==============================================================================
drop trigger if exists profiles_set_updated_at on public.profiles;
drop trigger if exists contacts_set_updated_at on public.contacts;
drop trigger if exists conversations_set_updated_at on public.conversations;
drop trigger if exists handoffs_set_updated_at on public.handoffs;
drop trigger if exists bot_config_state_set_updated_at on public.bot_config_state;
drop trigger if exists faq_set_updated_at on public.faq;
drop trigger if exists workspace_settings_set_updated_at on public.workspace_settings;

create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger contacts_set_updated_at before update on public.contacts for each row execute function public.set_updated_at();
create trigger conversations_set_updated_at before update on public.conversations for each row execute function public.set_updated_at();
create trigger handoffs_set_updated_at before update on public.handoffs for each row execute function public.set_updated_at();
create trigger bot_config_state_set_updated_at before update on public.bot_config_state for each row execute function public.set_updated_at();
create trigger faq_set_updated_at before update on public.faq for each row execute function public.set_updated_at();
create trigger workspace_settings_set_updated_at before update on public.workspace_settings for each row execute function public.set_updated_at();

-- ==============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ==============================================================================
alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.reminders enable row level security;
alter table public.handoffs enable row level security;
alter table public.conversation_events enable row level security;
alter table public.bot_config_state enable row level security;
alter table public.bot_config_revisions enable row level security;
alter table public.ai_calls enable row level security;
alter table public.faq enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.audit_log enable row level security;

-- Leitura de perfis
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select to authenticated using ((select auth.uid()) = id);

-- Leitura pública de FAQ
drop policy if exists faq_select_public on public.faq;
create policy faq_select_public on public.faq for select to anon, authenticated using (active = true or (select auth.uid()) is not null);

drop policy if exists workspace_settings_select_public on public.workspace_settings;
create policy workspace_settings_select_public on public.workspace_settings for select to anon, authenticated using (true);

-- Políticas Operacionais (Dashboard autenticado)
drop policy if exists contacts_staff_select on public.contacts;
create policy contacts_staff_select on public.contacts for select to authenticated using (public.is_active_staff(null));

drop policy if exists conversations_staff_select on public.conversations;
create policy conversations_staff_select on public.conversations for select to authenticated using (public.is_active_staff(null));

drop policy if exists messages_staff_select on public.conversation_messages;
create policy messages_staff_select on public.conversation_messages for select to authenticated using (public.is_active_staff(null));

drop policy if exists reminders_staff_select on public.reminders;
create policy reminders_staff_select on public.reminders for select to authenticated using (public.is_active_staff(null));

drop policy if exists handoffs_staff_select on public.handoffs;
create policy handoffs_staff_select on public.handoffs for select to authenticated using (public.is_active_staff(null));

drop policy if exists events_staff_select on public.conversation_events;
create policy events_staff_select on public.conversation_events for select to authenticated using (public.is_active_staff(null));

drop policy if exists config_state_staff_select on public.bot_config_state;
create policy config_state_staff_select on public.bot_config_state for select to authenticated using (public.is_active_staff(array['admin', 'operator']));

drop policy if exists config_revisions_staff_select on public.bot_config_revisions;
create policy config_revisions_staff_select on public.bot_config_revisions for select to authenticated using (public.is_active_staff(array['admin', 'operator']));

drop policy if exists ai_calls_staff_select on public.ai_calls;
create policy ai_calls_staff_select on public.ai_calls for select to authenticated using (public.is_active_staff(array['admin', 'operator']));

drop policy if exists audit_log_admin_select on public.audit_log;
create policy audit_log_admin_select on public.audit_log for select to authenticated using (public.is_active_staff(array['admin']));

-- ==============================================================================
-- CARGA INICIAL DE DADOS DA LIA
-- ==============================================================================
insert into public.bot_config_state (id, active_config, draft_config)
values (
  true,
  '{"identity":{"botName":"Lia"},"ai":{"temperature":0.3,"primaryModel":"gemini-3.8-flash","fallbackModel":"nvidia/nemotron-3.5-lightning:free"}}'::jsonb,
  '{"identity":{"botName":"Lia"},"ai":{"temperature":0.3,"primaryModel":"gemini-3.8-flash","fallbackModel":"nvidia/nemotron-3.5-lightning:free"}}'::jsonb
)
on conflict (id) do nothing;

insert into public.workspace_settings (id, aeo_faq)
values (true, '[]'::jsonb)
on conflict (id) do nothing;

-- FAQ Inicial da Lia
delete from public.faq where slug = 'falar-com-tauan';
insert into public.faq (slug, question, keys, answer, active, sort_order, metadata)
values
  (
    'quem-e-a-lia',
    'Quem é a Lia?',
    array['quem e voce','sobre a lia','o que voce faz','quem e a lia'],
    'Sou a Lia, assistente de atendimento da equipe! Faço a recepção por aqui, tiro dúvidas rápidas, anoto recados e te conecto com a equipe quando precisar.',
    true,
    10,
    '{}'::jsonb
  ),
  (
    'falar-com-responsavel',
    'Como falo com o responsável?',
    array['falar com responsavel','responsavel','falar com ele','humano','atendente'],
    'Com certeza! Já avisei a equipe que você chamou por aqui. Você vai receber o retorno diretamente assim que visualizarem!',
    true,
    20,
    '{}'::jsonb
  ),
  (
    'horarios-atendimento',
    'Qual o horário de atendimento?',
    array['horario','horarios','funcionamento','dias','quando atende'],
    'Nosso atendimento acontece geralmente de segunda a sexta, em horário comercial, mas você pode deixar sua mensagem a qualquer hora que a equipe responde.',
    true,
    30,
    '{}'::jsonb
  )
on conflict (slug) do update set
  question = excluded.question,
  keys = excluded.keys,
  answer = excluded.answer,
  active = excluded.active,
  sort_order = excluded.sort_order,
  metadata = excluded.metadata;

commit;
