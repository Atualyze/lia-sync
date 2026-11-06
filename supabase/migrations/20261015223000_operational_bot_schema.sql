-- Clubinho HomeVet — domínio operacional completo do bot
-- Depende de 20261015222000_initial_bot_schema.sql.
-- O runtime Node usa estas tabelas como fonte primária quando configurado;
-- os arquivos locais permanecem como dual-write e fallback temporário.

begin;

create or replace function public.is_active_staff(required_roles text[] default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.active = true
      and (required_roles is null or p.role = any(required_roles))
  );
$$;

revoke all on function public.is_active_staff(text[]) from public;
grant execute on function public.is_active_staff(text[]) to authenticated;

-- Contato do canal, separado da conta administrativa do dashboard.
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'other')),
  external_id text not null,
  phone text,
  display_name text,
  push_name text,
  source text,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, external_id)
);

comment on table public.contacts is 'Contatos atendidos pelo bot; não representa usuários administrativos.';
comment on column public.contacts.external_id is 'Identificador do canal, podendo ser telefone normalizado ou JID @lid.';

create index if not exists contacts_phone_idx on public.contacts (phone);
create index if not exists contacts_last_seen_idx on public.contacts (last_seen_at desc);

-- Pets identificados durante a coleta, sem obrigar um cadastro veterinário completo.
create table if not exists public.pets (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  name text,
  species text,
  breed text,
  age_text text,
  sex text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pets_contact_idx on public.pets (contact_id);

-- Uma conversa pode ser real ou simulação; external_key preserva o namespace sim:.
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts(id) on delete set null,
  external_key text not null unique,
  origin text not null default 'real' check (origin in ('real', 'simulation')),
  status text not null default 'open' check (status in ('open', 'archived', 'closed')),
  mode text not null default 'bot' check (mode in ('bot', 'human')),
  human_source text check (human_source in ('takeover', 'dashboard', 'resume', 'admin', 'auto-resume') or human_source is null),
  contact_name text,
  tutor_name text,
  preferred_time text,
  neighborhood text,
  pet_name text,
  pet_species text,
  pet_age text,
  last_intent text,
  intents text[] not null default '{}',
  symptom_turns integer not null default 0 check (symptom_turns >= 0),
  symptom_triage_until timestamptz,
  awaiting_reply boolean not null default false,
  inactivity_stage integer not null default 0 check (inactivity_stage >= 0 and inactivity_stage <= 3),
  inactivity_closed boolean not null default false,
  send_failed boolean not null default false,
  violations_count integer not null default 0 check (violations_count >= 0),
  fallback_handoff_at timestamptz,
  handoff_at timestamptz,
  handoff_reason text,
  handoff_urgency text check (handoff_urgency in ('normal', 'urgente', 'emergencia') or handoff_urgency is null),
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

comment on table public.conversations is 'Estado operacional equivalente a uma sessão do bot, preparado para substituir sessions.json.';

create index if not exists conversations_contact_idx on public.conversations (contact_id);
create index if not exists conversations_status_updated_idx on public.conversations (status, updated_at desc);
create index if not exists conversations_handoff_idx on public.conversations (mode, handoff_reminder_at) where mode = 'human';

-- Mensagens normalizadas, sem obrigar o armazenamento do payload bruto da Evolution.
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

-- Transferências para humano, incluindo lembretes e encerramento.
create table if not exists public.handoffs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  reason text not null,
  urgency text not null default 'normal' check (urgency in ('normal', 'urgente', 'emergencia')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'cancelled')),
  assigned_to uuid references public.profiles(id) on delete set null,
  notified_at timestamptz,
  reminder_15_sent_at timestamptz,
  reminder_60_sent_at timestamptz,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists handoffs_open_idx on public.handoffs (status, urgency, created_at desc) where status in ('open', 'acknowledged');
create index if not exists handoffs_conversation_idx on public.handoffs (conversation_id, created_at desc);

-- Auditoria de transições e ações automáticas/manuais.
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
create index if not exists conversation_events_type_idx on public.conversation_events (event_type, created_at desc);

-- Configuração publicada/rascunho do bot, fonte primária do runtime em vez de bot-config.json.
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

insert into public.bot_config_state (id)
values (true)
on conflict (id) do nothing;

create index if not exists bot_config_revisions_created_idx on public.bot_config_revisions (created_at desc);

-- Métricas persistentes de chamadas de IA. Não armazena prompt nem texto do cliente.
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

comment on table public.ai_calls is 'Telemetria sem prompts, respostas, telefones completos ou payloads do cliente.';

create index if not exists ai_calls_created_idx on public.ai_calls (created_at desc);
create index if not exists ai_calls_provider_idx on public.ai_calls (provider, created_at desc);
create index if not exists ai_calls_conversation_idx on public.ai_calls (conversation_id, created_at desc);

-- Auditoria administrativa geral.
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity_type, entity_id);

-- Atualização automática de timestamps.
drop trigger if exists contacts_set_updated_at on public.contacts;
drop trigger if exists pets_set_updated_at on public.pets;
drop trigger if exists conversations_set_updated_at on public.conversations;
drop trigger if exists handoffs_set_updated_at on public.handoffs;
drop trigger if exists bot_config_state_set_updated_at on public.bot_config_state;

create trigger contacts_set_updated_at
before update on public.contacts
for each row execute function public.set_updated_at();

create trigger pets_set_updated_at
before update on public.pets
for each row execute function public.set_updated_at();

create trigger conversations_set_updated_at
before update on public.conversations
for each row execute function public.set_updated_at();

create trigger handoffs_set_updated_at
before update on public.handoffs
for each row execute function public.set_updated_at();

create trigger bot_config_state_set_updated_at
before update on public.bot_config_state
for each row execute function public.set_updated_at();

-- RLS: dados operacionais são privados para usuários ativos do dashboard.
alter table public.contacts enable row level security;
alter table public.pets enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.handoffs enable row level security;
alter table public.conversation_events enable row level security;
alter table public.bot_config_state enable row level security;
alter table public.bot_config_revisions enable row level security;
alter table public.ai_calls enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists contacts_staff_select on public.contacts;
drop policy if exists pets_staff_select on public.pets;
drop policy if exists conversations_staff_select on public.conversations;
drop policy if exists messages_staff_select on public.conversation_messages;
drop policy if exists handoffs_staff_select on public.handoffs;
drop policy if exists events_staff_select on public.conversation_events;
drop policy if exists config_state_staff_select on public.bot_config_state;
drop policy if exists config_revisions_staff_select on public.bot_config_revisions;
drop policy if exists ai_calls_staff_select on public.ai_calls;
drop policy if exists audit_log_admin_select on public.audit_log;

create policy contacts_staff_select on public.contacts for select to authenticated using (public.is_active_staff(null));
create policy pets_staff_select on public.pets for select to authenticated using (public.is_active_staff(null));
create policy conversations_staff_select on public.conversations for select to authenticated using (public.is_active_staff(null));
create policy messages_staff_select on public.conversation_messages for select to authenticated using (public.is_active_staff(null));
create policy handoffs_staff_select on public.handoffs for select to authenticated using (public.is_active_staff(null));
create policy events_staff_select on public.conversation_events for select to authenticated using (public.is_active_staff(null));
create policy config_state_staff_select on public.bot_config_state for select to authenticated using (public.is_active_staff(array['admin', 'operator']));
create policy config_revisions_staff_select on public.bot_config_revisions for select to authenticated using (public.is_active_staff(array['admin', 'operator']));
create policy ai_calls_staff_select on public.ai_calls for select to authenticated using (public.is_active_staff(array['admin', 'operator']));
create policy audit_log_admin_select on public.audit_log for select to authenticated using (public.is_active_staff(array['admin']));

-- Escritas operacionais não ficam expostas pela chave do dashboard.
-- O backend futuro deverá usar RPCs controladas ou service_role fora do navegador.

commit;
