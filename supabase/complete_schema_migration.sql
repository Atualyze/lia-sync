-- ==============================================================================
-- LIA - ESQUEMA COMPLETO SUPABASE (GERADO)
-- ==============================================================================
-- GERADO AUTOMATICAMENTE: nao editar a mao. Fonte da verdade:
--   supabase/migrations/*.sql (em ordem cronologica de nome de arquivo).
-- Regenerar via scripts/generate-complete-schema.mjs.
-- Como aplicar: SQL Editor do Supabase -> colar este arquivo -> Run.
-- Cada migration e aditiva e idempotente; transacoes internas (begin/commit)
-- sao preservadas como estao, executadas em sequencia.
-- ==============================================================================

-- ======== 20261015222000_initial_bot_schema.sql ========
-- Clubinho HomeVet — schema independente do bot
-- Compatível com Supabase/PostgreSQL.
-- Esta migração não cria usuários Auth nem insere credenciais.

begin;

create extension if not exists pgcrypto;

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

-- Perfil de autorização do dashboard.
-- O id deve ser o mesmo UUID de auth.users.id.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'operator' check (role in ('admin', 'operator', 'viewer')),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Autorização dos usuários do dashboard do Clubinho HomeVet.';
comment on column public.profiles.active is 'Somente perfis ativos podem acessar as APIs protegidas do dashboard.';

create index if not exists profiles_active_role_idx on public.profiles (active, role);

-- Planos comerciais consumidos por src/faq.mjs.
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug = lower(slug) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  pet_species text not null default 'cao e gatos' check (pet_species in ('cao', 'gato', 'cao e gatos')),
  age_range text,
  monthly_price_cents integer check (monthly_price_cents is null or monthly_price_cents >= 0),
  annual_price_cents integer check (annual_price_cents is null or annual_price_cents >= 0),
  active boolean not null default true,
  description text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plans_has_price check (monthly_price_cents is not null or annual_price_cents is not null)
);

comment on table public.plans is 'Planos ativos exibidos pelo bot; valores sempre armazenados em centavos de BRL.';
comment on column public.plans.monthly_price_cents is 'Valor mensal em centavos de real, nunca em ponto flutuante.';
comment on column public.plans.annual_price_cents is 'Valor anual em centavos de real, nunca em ponto flutuante.';

create index if not exists plans_active_idx on public.plans (active);
create index if not exists plans_active_name_idx on public.plans (active, name);

-- FAQ adicional editável pelo CRM. O bot lê workspace_settings.aeo_faq.
create table if not exists public.workspace_settings (
  id boolean primary key default true check (id),
  aeo_faq jsonb not null default '[]'::jsonb check (jsonb_typeof(aeo_faq) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.workspace_settings is 'Configurações públicas de conhecimento usadas pelo bot.';
comment on column public.workspace_settings.aeo_faq is 'Array de itens com question, keys e answer; não armazenar segredos ou dados pessoais.';

-- FAQ normalizada e editável. workspace_settings.aeo_faq permanece como legado.
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

comment on table public.faq is 'Perguntas e respostas públicas usadas pelo bot e pelo painel de conhecimento.';
comment on column public.faq.keys is 'Palavras ou expressões normalizadas usadas para localizar a resposta.';
comment on column public.faq.active is 'Somente itens ativos são carregados pelo bot.';

create index if not exists faq_active_order_idx on public.faq (active, sort_order, created_at);

-- Região e horário públicos usados para compor FAQ dinâmica.
create table if not exists public.workspace_preferences (
  id boolean primary key default true check (id),
  service_regions text not null default 'todos os bairros de Teresina (PI) e a área urbana de Timon (MA)',
  working_start time not null default '08:00',
  working_end time not null default '18:00',
  timezone text not null default 'America/Fortaleza',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_hours_order check (working_end > working_start)
);

comment on table public.workspace_preferences is 'Preferências operacionais públicas usadas pela FAQ do bot.';

drop trigger if exists profiles_set_updated_at on public.profiles;
drop trigger if exists plans_set_updated_at on public.plans;
drop trigger if exists workspace_settings_set_updated_at on public.workspace_settings;
drop trigger if exists workspace_preferences_set_updated_at on public.workspace_preferences;
drop trigger if exists faq_set_updated_at on public.faq;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger plans_set_updated_at
before update on public.plans
for each row execute function public.set_updated_at();

create trigger workspace_settings_set_updated_at
before update on public.workspace_settings
for each row execute function public.set_updated_at();

create trigger workspace_preferences_set_updated_at
before update on public.workspace_preferences
for each row execute function public.set_updated_at();

create trigger faq_set_updated_at
before update on public.faq
for each row execute function public.set_updated_at();

insert into public.workspace_settings (id, aeo_faq)
values (true, '[]'::jsonb)
on conflict (id) do nothing;

insert into public.workspace_preferences (id)
values (true)
on conflict (id) do nothing;

-- RLS: o bot usa a publishable/anon key somente para leitura de conteúdo público.
-- A autorização do dashboard usa o access_token do Supabase e consulta o próprio profile.
alter table public.profiles enable row level security;
alter table public.plans enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.workspace_preferences enable row level security;
alter table public.faq enable row level security;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self
on public.profiles for select
to authenticated
using ((select auth.uid()) = id);

drop policy if exists plans_select_active on public.plans;
create policy plans_select_active
on public.plans for select
to anon, authenticated
using (active = true or (select auth.uid()) is not null);

drop policy if exists workspace_settings_select_public on public.workspace_settings;
create policy workspace_settings_select_public
on public.workspace_settings for select
to anon, authenticated
using (true);

drop policy if exists workspace_preferences_select_public on public.workspace_preferences;
create policy workspace_preferences_select_public
on public.workspace_preferences for select
to anon, authenticated
using (true);

drop policy if exists faq_select_public on public.faq;
create policy faq_select_public
on public.faq for select
to anon, authenticated
using (active = true or (select auth.uid()) is not null);

-- Não há políticas de INSERT/UPDATE/DELETE para anon ou authenticated.
-- Alterações administrativas devem ser feitas pelo SQL Editor, uma API segura
-- ou um backend com service_role; nunca exponha service_role no navegador.

commit;


-- ======== 20261015223000_operational_bot_schema.sql ========
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


-- ======== 20261016000000_faq_table.sql ========
-- Clubinho HomeVet — FAQ normalizada
-- A tabela substitui gradualmente workspace_settings.aeo_faq, que permanece
-- para compatibilidade com instalações anteriores.

begin;

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

comment on table public.faq is 'Perguntas e respostas públicas usadas pelo bot e pelo painel de conhecimento.';
comment on column public.faq.keys is 'Palavras ou expressões normalizadas usadas para localizar a resposta.';
comment on column public.faq.active is 'Somente itens ativos são carregados pelo bot.';

create index if not exists faq_active_order_idx on public.faq (active, sort_order, created_at);

drop trigger if exists faq_set_updated_at on public.faq;
create trigger faq_set_updated_at
before update on public.faq
for each row execute function public.set_updated_at();

alter table public.faq enable row level security;

drop policy if exists faq_select_public on public.faq;
create policy faq_select_public
on public.faq for select
to anon, authenticated
using (active = true or (select auth.uid()) is not null);

commit;


-- ======== 20261112210000_campaigns_bridge.sql ========
-- Lia Sync — fonte única de verdade para campanhas e jobs de envio.
-- Migração aditiva: não altera nem remove tabelas existentes. Não executar automaticamente.
begin;
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 200),
  message text not null check (length(btrim(message)) between 1 and 4000),
  status text not null default 'pending' check (status in ('pending','running','paused','completed','cancelled')),
  min_delay_seconds integer not null default 6 check (min_delay_seconds >= 3 and min_delay_seconds <= 86400),
  max_delay_seconds integer not null default 15 check (max_delay_seconds >= min_delay_seconds and max_delay_seconds <= 86400),
  total_recipients integer not null default 0 check (total_recipients >= 0),
  created_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  phone text not null check (phone ~ '^[0-9]{8,15}$'),
  name text not null default 'Cliente' check (length(name) between 1 and 160),
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, phone)
);
create table if not exists public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (length(btrim(scope)) between 1 and 80),
  key text not null check (length(btrim(key)) between 1 and 200),
  resource_id uuid,
  status_code integer not null default 200,
  response_body jsonb not null default '{}'::jsonb check (jsonb_typeof(response_body) = 'object'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  unique (scope, key)
);
create index if not exists campaigns_status_created_idx on public.campaigns (status, created_at desc);
create index if not exists campaigns_updated_idx on public.campaigns (updated_at desc);
create index if not exists campaign_recipients_queue_idx on public.campaign_recipients (campaign_id, status, created_at);
create index if not exists campaign_recipients_phone_idx on public.campaign_recipients (phone, status);
create index if not exists idempotency_keys_expiry_idx on public.idempotency_keys (expires_at);
drop trigger if exists campaigns_set_updated_at on public.campaigns;
create trigger campaigns_set_updated_at before update on public.campaigns for each row execute function public.set_updated_at();
drop trigger if exists campaign_recipients_set_updated_at on public.campaign_recipients;
create trigger campaign_recipients_set_updated_at before update on public.campaign_recipients for each row execute function public.set_updated_at();
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.idempotency_keys enable row level security;
drop policy if exists campaigns_staff_select on public.campaigns;
create policy campaigns_staff_select on public.campaigns for select to authenticated using (public.is_active_staff(array['admin','operator']));
drop policy if exists campaign_recipients_staff_select on public.campaign_recipients;
create policy campaign_recipients_staff_select on public.campaign_recipients for select to authenticated using (public.is_active_staff(array['admin','operator']));
-- Idempotency é exclusivamente backend/service-role; não expor chaves ou payloads ao browser.
comment on table public.idempotency_keys is 'Chaves de idempotência do bridge; sem políticas para anon/authenticated.';
commit;


-- ======== 20261112220000_phone_suppressions.sql ========
-- Lia Sync — supressão/opt-out canônico por telefone. Aditiva; não executar automaticamente.
begin;
create table if not exists public.phone_suppressions (
  phone text primary key check (phone ~ '^[0-9]{8,15}$'),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  source text not null check (length(btrim(source)) between 1 and 120),
  suppressed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists phone_suppressions_phone_uidx on public.phone_suppressions (phone);
drop trigger if exists phone_suppressions_set_updated_at on public.phone_suppressions;
create trigger phone_suppressions_set_updated_at before update on public.phone_suppressions for each row execute function public.set_updated_at();
alter table public.phone_suppressions enable row level security;
-- Sem policies anon/authenticated: não há leitura/escrita pelo browser; service-role bypassa RLS.
comment on table public.phone_suppressions is 'Fonte canônica backend-only de opt-out/supressão por telefone.';
alter table public.campaign_recipients drop constraint if exists campaign_recipients_status_check;
alter table public.campaign_recipients add constraint campaign_recipients_status_check check (status in ('pending','sent','failed','suppressed'));
commit;


-- ======== 20261113000000_operations_observability.sql ========
-- Lia Sync — concorrência de campanhas e observabilidade sanitizada de webhooks.
-- Aditiva; revisar e aplicar explicitamente antes do deploy do código correspondente.
begin;

alter table public.campaign_recipients
  add column if not exists attempt_count integer not null default 0;

alter table public.campaign_recipients
  drop constraint if exists campaign_recipients_status_check;
alter table public.campaign_recipients
  add constraint campaign_recipients_status_check
  check (status in ('pending','sending','sent','failed','suppressed'));

create index if not exists campaign_recipients_claim_idx
  on public.campaign_recipients (campaign_id, status, updated_at);

create table if not exists public.webhook_events (
  event_key text primary key check (event_key ~ '^[0-9a-f]{64}$'),
  event_type text not null check (length(event_type) between 1 and 120),
  instance_name text,
  status text not null default 'received' check (status in ('received','processed','ignored','failed')),
  attempt_count integer not null default 1 check (attempt_count >= 1),
  error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists webhook_events_received_idx
  on public.webhook_events (received_at desc);
create index if not exists webhook_events_status_idx
  on public.webhook_events (status, received_at desc);

drop trigger if exists webhook_events_set_updated_at on public.webhook_events;
create trigger webhook_events_set_updated_at
  before update on public.webhook_events
  for each row execute function public.set_updated_at();

alter table public.webhook_events enable row level security;
-- Sem policies para anon/authenticated; somente o backend com service_role acessa eventos.
comment on table public.webhook_events is 'Ledger de webhook sem payload, telefone, conteúdo de mensagem ou segredo; service-role only.';
comment on column public.webhook_events.event_key is 'SHA-256 do identificador de evento para dedupe; não guardar IDs externos em claro.';

commit;


-- ======== 20261113152048_follow_up_atomic_claim.sql ========
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS follow_up_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS follow_up_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS follow_up_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS follow_up_claim_token uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.conversations'::regclass
      AND conname = 'conversations_follow_up_count_nonnegative'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_follow_up_count_nonnegative CHECK (follow_up_count >= 0);
  END IF;
END;
$$;

-- Preserve follow-up history written by older runtimes in metadata.
UPDATE public.conversations
SET follow_up_count = CASE
      WHEN metadata->>'followUpCount' ~ '^[0-9]+$' THEN (metadata->>'followUpCount')::integer
      ELSE 0
    END,
    follow_up_sent_at = CASE
      WHEN metadata->>'followUpSentAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (metadata->>'followUpSentAt')::timestamptz
      ELSE NULL
    END,
    follow_up_claimed_at = CASE
      WHEN metadata->>'followUpClaimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (metadata->>'followUpClaimedAt')::timestamptz
      ELSE NULL
    END
WHERE metadata ?| ARRAY['followUpCount', 'followUpSentAt', 'followUpClaimedAt'];

CREATE OR REPLACE FUNCTION public.claim_follow_up(
  p_external_key text,
  p_claimed_at timestamptz,
  p_lease_seconds integer DEFAULT 900
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_token uuid;
  v_lease_seconds integer := GREATEST(60, LEAST(COALESCE(p_lease_seconds, 900), 3600));
BEGIN
  UPDATE public.conversations
  SET follow_up_count = 1,
      follow_up_claimed_at = p_claimed_at,
      follow_up_claim_token = gen_random_uuid(),
      updated_at = now()
  WHERE external_key = p_external_key
    AND status = 'open'
    AND mode = 'bot'
    AND follow_up_sent_at IS NULL
    AND (
      (follow_up_count = 0 AND follow_up_claim_token IS NULL)
      OR (follow_up_count = 1 AND follow_up_claimed_at < p_claimed_at - make_interval(secs => v_lease_seconds))
    )
  RETURNING follow_up_claim_token INTO v_token;
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_follow_up(
  p_external_key text,
  p_claim_token uuid,
  p_sent_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.conversations
  SET follow_up_sent_at = p_sent_at,
      follow_up_count = 1,
      follow_up_claimed_at = NULL,
      follow_up_claim_token = NULL,
      updated_at = now()
  WHERE external_key = p_external_key
    AND follow_up_claim_token = p_claim_token
    AND follow_up_sent_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_follow_up_claim(
  p_external_key text,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.conversations
  SET follow_up_count = 0,
      follow_up_claimed_at = NULL,
      follow_up_claim_token = NULL,
      updated_at = now()
  WHERE external_key = p_external_key
    AND follow_up_claim_token = p_claim_token
    AND follow_up_sent_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_follow_up(text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_follow_up(text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_follow_up_claim(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_follow_up(text, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_follow_up(text, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_follow_up_claim(text, uuid) TO service_role;


-- ======== 20261113153840_atomic_ai_budgets.sql ========
CREATE TABLE IF NOT EXISTS public.ai_budget_reservations (
  request_id uuid PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  reserved_usd numeric(20, 9) NOT NULL CHECK (reserved_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled boolean NOT NULL DEFAULT false,
  lease_expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS ai_budget_reservations_created_idx
  ON public.ai_budget_reservations (created_at DESC);

CREATE INDEX IF NOT EXISTS ai_calls_request_id_idx
  ON public.ai_calls (request_id)
  WHERE request_id IS NOT NULL;

ALTER TABLE public.ai_budget_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_budget_reservations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reserve_ai_budget(
  p_request_id uuid,
  p_provider text,
  p_model text,
  p_reserved_usd numeric,
  p_month_start timestamptz,
  p_budgets jsonb,
  p_rates jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_budget jsonb;
  v_rate jsonb;
  v_call record;
  v_budget_provider text;
  v_budget_model text;
  v_limit numeric;
  v_input_rate numeric;
  v_output_rate numeric;
  v_usage numeric;
  v_reserved numeric;
  v_request_applies boolean;
BEGIN
  IF p_request_id IS NULL
     OR p_provider NOT IN ('gemini', 'openrouter', 'qwen', 'openai')
     OR p_model IS NULL OR btrim(p_model) = ''
     OR p_reserved_usd IS NULL OR p_reserved_usd < 0
     OR p_month_start IS NULL
     OR jsonb_typeof(p_budgets) <> 'array'
     OR jsonb_typeof(p_rates) <> 'array' THEN
    RETURN false;
  END IF;

  -- Serialize all admissions within a UTC calendar month across app instances.
  PERFORM pg_advisory_xact_lock(hashtext('lia_ai_budget:' || to_char(p_month_start AT TIME ZONE 'UTC', 'YYYY-MM'))::bigint);

  -- Once the matching call is durably present in ai_calls, it is the source of truth;
  -- remove the duplicate reservation row. Expired, un-settled leases represent work
  -- that died before it could be accounted for and can no longer consume this month.
  DELETE FROM public.ai_budget_reservations r
  WHERE EXISTS (SELECT 1 FROM public.ai_calls c WHERE c.request_id = r.request_id::text)
     OR (r.settled = false AND r.lease_expires_at < now());

  FOR v_budget IN SELECT value FROM jsonb_array_elements(p_budgets) AS items(value) LOOP
    BEGIN
      v_budget_provider := coalesce(v_budget->>'provider', '');
      v_budget_model := coalesce(v_budget->>'model', '');
      v_limit := (v_budget->>'amountUsd')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RETURN false;
    END;

    IF v_limit IS NULL OR v_limit <= 0 THEN RETURN false; END IF;
    IF (v_budget_provider <> '' AND v_budget_provider NOT IN ('gemini', 'openrouter', 'qwen', 'openai')) THEN RETURN false; END IF;

    v_request_applies := (v_budget_provider = '' OR v_budget_provider = p_provider)
      AND (v_budget_model = '' OR v_budget_model = p_model);
    IF NOT v_request_applies THEN CONTINUE; END IF;

    v_usage := 0;
    FOR v_call IN
      SELECT c.provider, c.model, c.prompt_tokens, c.completion_tokens, c.success
      FROM public.ai_calls c
      WHERE c.created_at >= p_month_start
        AND (v_budget_provider = '' OR c.provider = v_budget_provider)
        AND (v_budget_model = '' OR c.model = v_budget_model)
    LOOP
      IF v_call.success IS DISTINCT FROM true OR v_call.model IS NULL THEN RETURN false; END IF;
      v_input_rate := NULL;
      v_output_rate := NULL;
      FOR v_rate IN SELECT value FROM jsonb_array_elements(p_rates) AS rates(value) LOOP
        IF v_rate->>'provider' = v_call.provider AND v_rate->>'model' = v_call.model THEN
          BEGIN
            v_input_rate := (v_rate->>'inputUsdPerMillion')::numeric;
            v_output_rate := (v_rate->>'outputUsdPerMillion')::numeric;
          EXCEPTION WHEN OTHERS THEN
            RETURN false;
          END;
          EXIT;
        END IF;
      END LOOP;
      IF v_input_rate IS NULL OR v_output_rate IS NULL OR v_input_rate < 0 OR v_output_rate < 0 THEN RETURN false; END IF;
      v_usage := v_usage + ((v_call.prompt_tokens * v_input_rate) + (v_call.completion_tokens * v_output_rate)) / 1000000;
    END LOOP;

    SELECT coalesce(sum(r.reserved_usd), 0) INTO v_reserved
    FROM public.ai_budget_reservations r
    WHERE r.created_at >= p_month_start
      AND (r.settled = true OR r.lease_expires_at > now())
      AND (v_budget_provider = '' OR r.provider = v_budget_provider)
      AND (v_budget_model = '' OR r.model = v_budget_model)
      AND NOT EXISTS (SELECT 1 FROM public.ai_calls c WHERE c.request_id = r.request_id::text);

    IF v_usage + v_reserved + p_reserved_usd > v_limit THEN RETURN false; END IF;
  END LOOP;

  INSERT INTO public.ai_budget_reservations (request_id, provider, model, reserved_usd, created_at, settled, lease_expires_at)
  VALUES (p_request_id, p_provider, p_model, p_reserved_usd, now(), false, now() + interval '5 minutes')
  ON CONFLICT (request_id) DO NOTHING;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_ai_budget(
  p_request_id uuid,
  p_actual_usd numeric
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_request_id IS NULL OR p_actual_usd IS NULL OR p_actual_usd < 0 THEN RETURN false; END IF;
  UPDATE public.ai_budget_reservations
  SET reserved_usd = greatest(reserved_usd, p_actual_usd),
      settled = true,
      lease_expires_at = NULL
  WHERE request_id = p_request_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_ai_budget(
  p_request_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_request_id IS NULL THEN RETURN false; END IF;
  DELETE FROM public.ai_budget_reservations
  WHERE request_id = p_request_id AND settled = false
    AND NOT EXISTS (SELECT 1 FROM public.ai_calls c WHERE c.request_id = p_request_id::text);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_ai_budget(uuid, text, text, numeric, timestamptz, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_ai_budget(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_ai_budget(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_budget(uuid, text, text, numeric, timestamptz, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_ai_budget(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ai_budget(uuid) TO service_role;


-- ======== 20261113154223_ai_budget_effective_model.sql ========
ALTER TABLE public.ai_budget_reservations
  ADD COLUMN IF NOT EXISTS usage_unknown boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.reserve_ai_budget(
  p_request_id uuid,
  p_provider text,
  p_model text,
  p_reserved_usd numeric,
  p_month_start timestamptz,
  p_budgets jsonb,
  p_rates jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_budget jsonb;
  v_rate jsonb;
  v_call record;
  v_budget_provider text;
  v_budget_model text;
  v_limit numeric;
  v_input_rate numeric;
  v_output_rate numeric;
  v_usage numeric;
  v_reserved numeric;
  v_request_applies boolean;
  v_inserted integer;
BEGIN
  IF p_request_id IS NULL
     OR p_provider NOT IN ('gemini', 'openrouter', 'qwen', 'openai')
     OR p_model IS NULL OR btrim(p_model) = ''
     OR p_reserved_usd IS NULL OR p_reserved_usd < 0
     OR p_month_start IS NULL
     OR date_trunc('month', p_month_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' <> p_month_start
     OR jsonb_typeof(p_budgets) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_rates) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('lia_ai_budget:' || to_char(p_month_start AT TIME ZONE 'UTC', 'YYYY-MM'))::bigint);

  DELETE FROM public.ai_budget_reservations r
  WHERE r.created_at < p_month_start
     OR EXISTS (SELECT 1 FROM public.ai_calls c WHERE c.request_id = r.request_id::text)
     OR (r.settled = false AND r.lease_expires_at < now());

  FOR v_budget IN SELECT value FROM jsonb_array_elements(p_budgets) AS items(value) LOOP
    IF jsonb_typeof(v_budget) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    BEGIN
      v_budget_provider := coalesce(v_budget->>'provider', '');
      v_budget_model := coalesce(v_budget->>'model', '');
      v_limit := (v_budget->>'amountUsd')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RETURN false;
    END;

    IF v_limit IS NULL OR v_limit <= 0 THEN RETURN false; END IF;
    IF (v_budget_provider <> '' AND v_budget_provider NOT IN ('gemini', 'openrouter', 'qwen', 'openai')) THEN RETURN false; END IF;

    v_request_applies := (v_budget_provider = '' OR v_budget_provider = p_provider)
      AND (v_budget_model = '' OR v_budget_model = p_model);
    IF NOT v_request_applies THEN CONTINUE; END IF;

    IF EXISTS (
      SELECT 1 FROM public.ai_budget_reservations r
      WHERE r.created_at >= p_month_start
        AND r.created_at < p_month_start + interval '1 month'
        AND r.usage_unknown
        AND (v_budget_provider = '' OR r.provider = v_budget_provider)
        AND (v_budget_model = '' OR r.model = v_budget_model)
        AND NOT EXISTS (SELECT 1 FROM public.ai_calls c WHERE c.request_id = r.request_id::text)
    ) THEN RETURN false; END IF;

    v_usage := 0;
    FOR v_call IN
      SELECT c.provider, c.model, c.prompt_tokens, c.completion_tokens, c.success
      FROM public.ai_calls c
      WHERE c.created_at >= p_month_start
        AND c.created_at < p_month_start + interval '1 month'
        AND (v_budget_provider = '' OR c.provider = v_budget_provider)
        AND (v_budget_model = '' OR c.model = v_budget_model)
    LOOP
      IF v_call.success IS DISTINCT FROM true OR v_call.model IS NULL THEN RETURN false; END IF;
      v_input_rate := NULL;
      v_output_rate := NULL;
      FOR v_rate IN SELECT value FROM jsonb_array_elements(p_rates) AS rates(value) LOOP
        IF v_rate->>'provider' = v_call.provider AND v_rate->>'model' = v_call.model THEN
          BEGIN
            v_input_rate := (v_rate->>'inputUsdPerMillion')::numeric;
            v_output_rate := (v_rate->>'outputUsdPerMillion')::numeric;
          EXCEPTION WHEN OTHERS THEN
            RETURN false;
          END;
          EXIT;
        END IF;
      END LOOP;
      IF v_input_rate IS NULL OR v_output_rate IS NULL OR v_input_rate < 0 OR v_output_rate < 0 THEN RETURN false; END IF;
      v_usage := v_usage + ((v_call.prompt_tokens * v_input_rate) + (v_call.completion_tokens * v_output_rate)) / 1000000;
    END LOOP;

    SELECT coalesce(sum(r.reserved_usd), 0) INTO v_reserved
    FROM public.ai_budget_reservations r
    WHERE r.created_at >= p_month_start
      AND r.created_at < p_month_start + interval '1 month'
      AND (r.settled = true OR r.lease_expires_at > now())
      AND (v_budget_provider = '' OR r.provider = v_budget_provider)
      AND (v_budget_model = '' OR r.model = v_budget_model)
      AND NOT EXISTS (SELECT 1 FROM public.ai_calls c WHERE c.request_id = r.request_id::text);

    IF v_usage + v_reserved + p_reserved_usd > v_limit THEN RETURN false; END IF;
  END LOOP;

  INSERT INTO public.ai_budget_reservations (request_id, provider, model, reserved_usd, created_at, settled, lease_expires_at, usage_unknown)
  VALUES (p_request_id, p_provider, p_model, p_reserved_usd, now(), false, now() + interval '5 minutes', false)
  ON CONFLICT (request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_ai_budget_effective(
  p_request_id uuid,
  p_provider text,
  p_model text,
  p_actual_usd numeric,
  p_usage_unknown boolean
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_created_at timestamptz;
  v_updated integer;
BEGIN
  IF p_request_id IS NULL
     OR p_provider NOT IN ('gemini', 'openrouter', 'qwen', 'openai')
     OR p_model IS NULL OR btrim(p_model) = ''
     OR p_actual_usd IS NULL OR p_actual_usd < 0
     OR p_usage_unknown IS NULL THEN
    RETURN false;
  END IF;

  SELECT created_at INTO v_created_at
  FROM public.ai_budget_reservations
  WHERE request_id = p_request_id;
  IF v_created_at IS NULL THEN RETURN false; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('lia_ai_budget:' || to_char(v_created_at AT TIME ZONE 'UTC', 'YYYY-MM'))::bigint);

  UPDATE public.ai_budget_reservations
  SET provider = p_provider,
      model = p_model,
      reserved_usd = greatest(reserved_usd, p_actual_usd),
      settled = true,
      usage_unknown = p_usage_unknown,
      lease_expires_at = NULL
  WHERE request_id = p_request_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_ai_budget(uuid, text, text, numeric, timestamptz, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_ai_budget_effective(uuid, text, text, numeric, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_budget(uuid, text, text, numeric, timestamptz, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_ai_budget_effective(uuid, text, text, numeric, boolean) TO service_role;


-- ======== 20261114072000_runtime_projections.sql ========
-- Lia Sync — tabela dedicada para projeções de runtime (ex.: setores sincronizados pelo Chatwoot).
-- Mantém projeções externas fora de bot_config_state.draft_config e active_config.
begin;

create table if not exists public.runtime_projections (
  key text primary key check (length(key) between 1 and 120),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now()
);

drop trigger if exists runtime_projections_set_updated_at on public.runtime_projections;
create trigger runtime_projections_set_updated_at
  before update on public.runtime_projections
  for each row execute function public.set_updated_at();

alter table public.runtime_projections enable row level security;
-- Sem policies para anon/authenticated; somente o backend com service_role acessa projeções de runtime.
comment on table public.runtime_projections is 'Projeções efêmeras de runtime (ex.: setores do Chatwoot); service-role only.';

commit;


-- ======== 20261115000000_prospecting.sql ========
-- Prospecção autônoma (Fase 1): listas, leads, cadências e eventos.
-- Reutiliza phone_suppressions como fonte única de opt-out.

CREATE TABLE IF NOT EXISTS prospect_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'csv',
  segment TEXT NOT NULL DEFAULT '',
  consent_basis TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'paused', -- paused | active | stopped | completed
  daily_cap INTEGER NOT NULL DEFAULT 20,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  warmup_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prospect_cadences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES prospect_lists(id) ON DELETE CASCADE,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prospect_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES prospect_lists(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'new', -- new | queued | contacted | replied | handoff | opted_out | stopped | failed | exhausted
  stage INTEGER NOT NULL DEFAULT 0,
  next_action_at TIMESTAMPTZ,
  last_contacted_at TIMESTAMPTZ,
  claim_token TEXT,
  claimed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (list_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_prospect_leads_due
  ON prospect_leads (status, next_action_at)
  WHERE status IN ('new', 'queued', 'failed', 'contacted');

CREATE INDEX IF NOT EXISTS idx_prospect_leads_phone
  ON prospect_leads (phone);

CREATE TABLE IF NOT EXISTS prospect_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID REFERENCES prospect_lists(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES prospect_leads(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  event_type TEXT NOT NULL, -- queued | sent | failed | replied | optout | handoff | stopped
  stage INTEGER,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prospect_events_list_created
  ON prospect_events (list_id, created_at DESC);

-- Estas tabelas contêm dados pessoais de leads. O dashboard usa apenas o
-- service_role no backend; a chave publicável nunca deve acessar o REST delas.
ALTER TABLE prospect_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_cadences ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE prospect_lists, prospect_cadences, prospect_leads, prospect_events FROM anon, authenticated;
GRANT ALL ON TABLE prospect_lists, prospect_cadences, prospect_leads, prospect_events TO service_role;


-- ======== 20261115000100_sync_archive.sql ========
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


-- ======== 20261116000000_review_hardening.sql ========
-- Lia Sync — endurecimento de persistência, jobs e banco (revisão de 2026-11-16).
--
-- Aditiva e idempotente: pode ser aplicada em bancos que já executaram as migrations
-- anteriores sem recriar nada, e em bancos parcialmente migrados (usa to_regclass /
-- add column if not exists). Não executa automaticamente; revisar e aplicar de forma
-- explícita, como as demais migrations deste diretório.
--
-- Conteúdo:
--   a) RLS (sem policies) nas quatro tabelas de prospecção — service-role only.
--   b) conversations.legal_hold — flag de retenção que o flush de sessão não sobrescreve.
--   c) tabela public.reminders alinhada ao runtime, com created_by sem CHECK restritivo.
--   d) RPC claim_maintenance_lease — lease distribuído para o loop de manutenção.
begin;

-- ---------------------------------------------------------------------------
-- (a) Prospecção: PII de leads nunca pode ser lida com a chave publishable.
--
-- As tabelas foram criadas sem `enable row level security`; no Supabase isso as
-- deixa expostas ao PostgREST com as roles anon/authenticated. Habilitar RLS sem
-- criar nenhuma policy mantém o acesso exclusivo do service_role (que ignora RLS).
-- `to_regclass` mantém a migration idempotente e segura em bancos onde a migration
-- de prospecção ainda não foi aplicada.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.prospect_lists') is not null then
    execute 'alter table public.prospect_lists enable row level security';
    execute 'comment on table public.prospect_lists is ''Listas de prospecção; RLS sem policies: service-role only.''';
  end if;

  if to_regclass('public.prospect_cadences') is not null then
    execute 'alter table public.prospect_cadences enable row level security';
    execute 'comment on table public.prospect_cadences is ''Cadências de prospecção; RLS sem policies: service-role only.''';
  end if;

  if to_regclass('public.prospect_leads') is not null then
    execute 'alter table public.prospect_leads enable row level security';
    execute 'comment on table public.prospect_leads is ''Leads de prospecção (PII); RLS sem policies: service-role only.''';
    -- Suporte à recuperação de claims órfãs (lease expirado) em listDueLeads.
    execute 'create index if not exists idx_prospect_leads_claim on public.prospect_leads (status, claimed_at) where claim_token is not null';
  end if;

  if to_regclass('public.prospect_events') is not null then
    execute 'alter table public.prospect_events enable row level security';
    execute 'comment on table public.prospect_events is ''Eventos de prospecção; RLS sem policies: service-role only.''';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (b) conversations.legal_hold
--
-- O sweep de retenção precisa distinguir "pode expurgar" de "preservar por
-- obrigação legal". Hoje o único sinal é metadata->>'legalHold', que o flush de
-- sessão reescreve por inteiro a cada ciclo — logo o hold se perde. Uma coluna
-- dedicada não é tocada por sessionToConversation (outro dono) e pode ser
-- ligada/desligada sem risco de ser apagada por um flush concorrente.
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column if not exists legal_hold boolean not null default false;

comment on column public.conversations.legal_hold is
  'Impede o expurgo por retenção. Coluna dedicada: nunca derivada de metadata de sessão.';

create index if not exists conversations_legal_hold_idx
  on public.conversations (legal_hold, updated_at)
  where legal_hold;

-- ---------------------------------------------------------------------------
-- (c) public.reminders alinhada ao runtime (src/reminders.mjs)
--
-- A tabela só existia em complete_schema_migration.sql, que não é uma migration
-- versionada, e trazia `created_by ... check (created_by in ('tauan','contato','sistema'))`
-- enquanto o código grava 'lia' e 'owner'. Resultado: 23514 e nenhum lembrete
-- criado. Aqui a tabela é criada de forma versionada, o CHECK antigo é removido
-- e o default vai para o valor neutro 'sistema'.
-- ---------------------------------------------------------------------------
create table if not exists public.reminders (
  id text primary key,
  text text not null,
  due_at timestamptz not null,
  phone text,
  client_name text,
  created_by text not null default 'sistema',
  status text not null default 'pending',
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- Bancos que já têm a tabela (via complete_schema) podem estar sem alguma coluna.
alter table public.reminders add column if not exists text text;
alter table public.reminders add column if not exists due_at timestamptz;
alter table public.reminders add column if not exists phone text;
alter table public.reminders add column if not exists client_name text;
alter table public.reminders add column if not exists created_by text;
alter table public.reminders add column if not exists status text;
alter table public.reminders add column if not exists sent_at timestamptz;
alter table public.reminders add column if not exists created_at timestamptz;

alter table public.reminders alter column created_by set default 'sistema';
alter table public.reminders alter column status set default 'pending';
alter table public.reminders alter column created_at set default now();

-- O CHECK original restringia a três valores e não cobria 'lia'/'owner' do runtime.
alter table public.reminders drop constraint if exists reminders_created_by_check;

create index if not exists reminders_pending_due_idx
  on public.reminders (status, due_at)
  where status = 'pending';

alter table public.reminders enable row level security;
comment on table public.reminders is
  'Lembretes do Copiloto; RLS sem policies: service-role only. created_by é livre (lia/owner/contato/sistema).';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.reminders from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.reminders from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (d) claim_maintenance_lease — lease distribuído para o loop de manutenção.
--
-- Sem isso, cada réplica roda lembretes, aviso de janela e recuperação de
-- checkout ao mesmo tempo e o cliente recebe a mesma mensagem (link Pix incluso)
-- mais de uma vez. A reserva é atômica: só uma chamada consegue atualizar
-- runtime_projections com a chave 'maintenance_lease' enquanto o lease anterior
-- não expirou. Idempotente por natureza (ON CONFLICT), sem tabela nova.
--
-- Retorna true quando ESTA chamada obteve o lease.
-- ---------------------------------------------------------------------------
create or replace function public.claim_maintenance_lease(
  p_owner text,
  p_ttl_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner text := nullif(btrim(coalesce(p_owner, '')), '');
  v_ttl integer := greatest(30, least(coalesce(p_ttl_seconds, 300), 3600));
  v_rows integer := 0;
begin
  if v_owner is null then
    return false;
  end if;

  insert into public.runtime_projections as rp (key, payload, updated_at)
  values (
    'maintenance_lease',
    jsonb_build_object('owner', v_owner, 'acquired_at', now()),
    now()
  )
  on conflict (key) do update
    set payload = jsonb_build_object('owner', v_owner, 'acquired_at', now()),
        updated_at = now()
    where rp.updated_at < now() - make_interval(secs => v_ttl);

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.claim_maintenance_lease(text, integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.claim_maintenance_lease(text, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.claim_maintenance_lease(text, integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.claim_maintenance_lease(text, integer) to service_role';
  end if;
end $$;

comment on function public.claim_maintenance_lease(text, integer) is
  'Lease distribuído do loop de manutenção; reserva atômica em runtime_projections. Service-role only.';

commit;


-- ======== 20261120150000_copilot_task_queue.sql ========
begin;

create table if not exists public.copilot_tasks (
  id uuid primary key default gen_random_uuid(),
  task_key text not null unique,
  owner_key text not null,
  target_phone text,
  request_summary text not null default '',
  actor_label text not null default 'responsável',
  steps jsonb not null check (
    jsonb_typeof(steps) = 'array'
    and jsonb_array_length(steps) between 1 and 4
  ),
  retry_policy text not null default 'never'
    check (retry_policy in ('read_only', 'never')),
  constraint copilot_tasks_pix_never_retries check (
    retry_policy <> 'read_only'
    or not (steps @> '[{"name":"gerar_cobranca_pix"}]'::jsonb)
  ),
  constraint copilot_tasks_pix_single_step check (
    not (steps @> '[{"name":"gerar_cobranca_pix"}]'::jsonb)
    or jsonb_array_length(steps) = 1
  ),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'awaiting_input', 'succeeded', 'failed', 'uncertain', 'cancelled')),
  result_text text,
  result_summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result_summary) = 'object'),
  last_error_code text,
  current_step integer not null default 0 check (current_step between 0 and 4),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 1 check (max_attempts between 1 and 3),
  available_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '6 hours'),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  notification_status text not null default 'pending'
    check (notification_status in ('pending', 'sending', 'sent', 'uncertain', 'unaddressable')),
  notified_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint copilot_tasks_lease_consistency check (
    (status = 'running' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'running')
  )
);

create index if not exists copilot_tasks_queue_idx
  on public.copilot_tasks (status, available_at, created_at)
  where status = 'queued';

create index if not exists copilot_tasks_owner_idx
  on public.copilot_tasks (owner_key, created_at desc);

create index if not exists copilot_tasks_lease_idx
  on public.copilot_tasks (lease_expires_at)
  where status = 'running';

alter table public.copilot_tasks enable row level security;
revoke all on public.copilot_tasks from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.copilot_tasks from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.copilot_tasks from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.copilot_tasks to service_role';
  end if;
end $$;

create or replace function public.claim_copilot_task(
  p_worker text,
  p_lease_seconds integer default 180
)
returns setof public.copilot_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_task public.copilot_tasks;
begin
  -- Uma execução interrompida pode voltar à fila apenas quando a ferramenta
  -- é estritamente somente-leitura. Efeitos externos/artifacts viram incertos.
  update public.copilot_tasks
  set
    status = case
      when retry_policy = 'read_only' and attempt_count < max_attempts then 'queued'
      when retry_policy = 'read_only' then 'failed'
      else 'uncertain'
    end,
    last_error_code = case
      when retry_policy = 'read_only' and attempt_count < max_attempts then 'read_only_lease_expired'
      when retry_policy = 'read_only' then 'read_only_attempts_exhausted'
      else 'execution_lease_expired'
    end,
    result_text = case
      when retry_policy = 'read_only' and attempt_count < max_attempts then result_text
      when retry_policy = 'read_only' then 'A consulta foi interrompida após atingir o limite de tentativas seguras. Nenhuma ação externa foi repetida.'
      else 'A execução foi interrompida e o resultado ficou incerto. É necessária uma conferência antes de qualquer nova tentativa.'
    end,
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now(),
    completed_at = case
      when retry_policy = 'read_only' and attempt_count < max_attempts then null
      else now()
    end
  where status = 'running'
    and lease_expires_at <= now();

  -- Uma notificação pode ter sido aceita pelo WhatsApp antes da queda.
  -- Nunca liberamos novamente uma entrega cujo resultado seja incerto.
  update public.copilot_tasks
  set
    notification_status = 'uncertain',
    last_error_code = 'notification_lease_expired',
    updated_at = now()
  where status in ('succeeded', 'failed', 'uncertain')
    and notification_status = 'sending'
    and updated_at <= now() - interval '2 minutes';

  update public.copilot_tasks
  set
    status = 'failed',
    last_error_code = 'task_expired_before_execution',
    result_text = 'A tarefa expirou antes de começar. Nenhuma ferramenta foi executada.',
    completed_at = now(),
    updated_at = now()
  where status = 'queued'
    and expires_at <= now();

  select id into v_id
  from public.copilot_tasks
  where status = 'queued'
    and available_at <= now()
    and expires_at > now()
    and attempt_count < max_attempts
  order by created_at asc
  limit 1
  for update skip locked;

  if v_id is null then
    return;
  end if;

  update public.copilot_tasks
  set
    status = 'running',
    attempt_count = attempt_count + 1,
    lease_owner = left(coalesce(nullif(p_worker, ''), 'lia-worker'), 120),
    lease_token = gen_random_uuid(),
    lease_expires_at = now() + make_interval(secs => greatest(30, least(600, coalesce(p_lease_seconds, 180)))),
    started_at = coalesce(started_at, now()),
    updated_at = now()
  where id = v_id
  returning * into v_task;

  return next v_task;
end;
$$;

revoke all on function public.claim_copilot_task(text, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.claim_copilot_task(text, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.claim_copilot_task(text, integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.claim_copilot_task(text, integer) to service_role';
  end if;
end $$;

comment on table public.copilot_tasks is
  'Fila persistente do Copiloto. Acesso backend-only; argumentos e resultados nunca são expostos ao browser.';
comment on function public.claim_copilot_task(text, integer) is
  'Reivindica uma tarefa em transação com SKIP LOCKED. Reexecuta somente-leitura após lease expirado; efeitos externos ficam incertos. Service-role only.';

commit;


-- ======== 20261121100000_lia_runtime.sql ========
begin;

create table if not exists public.lia_identity (
  id text primary key default 'primary',
  identity jsonb not null default '{}'::jsonb check (jsonb_typeof(identity) = 'object'),
  role text not null default 'assistente_operacional',
  principles jsonb not null default '[]'::jsonb check (jsonb_typeof(principles) = 'array'),
  operating_mode text not null default 'assisted'
    check (operating_mode in ('passive', 'assisted', 'proactive_safe')),
  owner_preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(owner_preferences) = 'object'),
  current_status text not null default 'idle'
    check (current_status in ('idle', 'observing', 'evaluating', 'planning', 'working', 'waiting', 'blocked', 'needs_human', 'recovering')),
  active_objectives jsonb not null default '[]'::jsonb check (jsonb_typeof(active_objectives) = 'array'),
  active_commitments jsonb not null default '[]'::jsonb check (jsonb_typeof(active_commitments) = 'array'),
  watched_items jsonb not null default '[]'::jsonb check (jsonb_typeof(watched_items) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lia_goals (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  indicator text not null default '',
  target_value numeric,
  current_value numeric not null default 0,
  progress integer not null default 0 check (progress between 0 and 100),
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'critical')),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'completed', 'cancelled', 'failed')),
  deadline_at timestamptz,
  task_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(task_ids) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists lia_goals_status_priority_idx
  on public.lia_goals (status, priority, deadline_at);

create table if not exists public.lia_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  source text not null default 'system',
  subject text not null default '',
  occurred_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'critical')),
  deduplication_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'failed', 'dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  last_error text,
  attention jsonb not null default '{}'::jsonb check (jsonb_typeof(attention) = 'object'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists lia_events_pending_idx
  on public.lia_events (status, priority, occurred_at)
  where status in ('pending', 'processing');

create table if not exists public.lia_commitments (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  subject text not null default '',
  due_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'fulfilled', 'missed', 'cancelled')),
  goal_id uuid references public.lia_goals(id) on delete set null,
  notified_event_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fulfilled_at timestamptz
);

create index if not exists lia_commitments_due_idx
  on public.lia_commitments (status, due_at)
  where status = 'pending';

create table if not exists public.lia_runtime_state (
  id text primary key default 'primary',
  state text not null default 'idle'
    check (state in ('idle', 'observing', 'evaluating', 'planning', 'working', 'waiting', 'blocked', 'needs_human', 'recovering')),
  state_entered_at timestamptz not null default now(),
  last_wake_at timestamptz,
  last_sleep_at timestamptz,
  last_recovery_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  updated_at timestamptz not null default now()
);

do $$
declare
  tbl text;
begin
  foreach tbl in array array['lia_identity', 'lia_goals', 'lia_events', 'lia_commitments', 'lia_runtime_state'] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on public.%I from public', tbl);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', tbl);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', tbl);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on public.%I to service_role', tbl);
    end if;
  end loop;
end $$;

commit;

-- ======== 20261121120000_lia_learning.sql ========
begin;

create table if not exists public.lia_experiences (
  id uuid primary key default gen_random_uuid(),
  deduplication_key text not null unique,
  occurred_at timestamptz not null default now(),
  actor text not null default 'runtime',
  source text not null default 'system',
  scope text not null default 'business'
    check (scope in ('individual', 'relationship', 'business', 'segment', 'global')),
  subject text not null default '',
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  goal_id uuid references public.lia_goals(id) on delete set null,
  task_id uuid,
  action text not null default '',
  expected_result text not null default '',
  actual_result text not null default '',
  outcome text not null default 'uncertain'
    check (outcome in ('success', 'partial_success', 'failure', 'uncertain', 'abandoned')),
  feedback jsonb not null default '[]'::jsonb check (jsonb_typeof(feedback) = 'array'),
  error text,
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  significance text not null default 'medium'
    check (significance in ('low', 'medium', 'high', 'critical')),
  reflected boolean not null default false,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lia_experiences_unreflected_idx
  on public.lia_experiences (reflected, significance, occurred_at desc);

create table if not exists public.lia_knowledge (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'inference'
    check (kind in ('fact', 'inference', 'hypothesis', 'strategy', 'rule', 'preference')),
  scope text not null default 'business'
    check (scope in ('individual', 'relationship', 'business', 'segment', 'global')),
  subject text not null default '',
  topic text not null default '',
  content text not null,
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  evidence_count integer not null default 1 check (evidence_count >= 0),
  positive_evidence integer not null default 0 check (positive_evidence >= 0),
  negative_evidence integer not null default 0 check (negative_evidence >= 0),
  last_validated_at timestamptz,
  last_invalidated_at timestamptz,
  status text not null default 'candidate'
    check (status in ('candidate', 'experimental', 'supported', 'consolidated', 'deprecated', 'contradicted')),
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lia_knowledge_scope_status_idx
  on public.lia_knowledge (scope, status, confidence desc);

create table if not exists public.lia_hypotheses (
  id uuid primary key default gen_random_uuid(),
  statement text not null,
  scope text not null default 'business'
    check (scope in ('individual', 'relationship', 'business', 'segment', 'global')),
  metric text not null default 'reply_rate',
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  positive_evidence integer not null default 0 check (positive_evidence >= 0),
  negative_evidence integer not null default 0 check (negative_evidence >= 0),
  status text not null default 'candidate'
    check (status in ('candidate', 'experimental', 'supported', 'consolidated', 'deprecated', 'contradicted')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lia_strategies (
  id uuid primary key default gen_random_uuid(),
  strategy_key text not null,
  version integer not null default 1 check (version >= 1),
  scope text not null default 'business'
    check (scope in ('individual', 'relationship', 'business', 'segment', 'global')),
  status text not null default 'draft'
    check (status in ('draft', 'experimental', 'active', 'deprecated', 'disabled')),
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  definition jsonb not null default '{}'::jsonb check (jsonb_typeof(definition) = 'object'),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (strategy_key, version, scope)
);

create table if not exists public.lia_experiments (
  id uuid primary key default gen_random_uuid(),
  hypothesis_id uuid references public.lia_hypotheses(id) on delete set null,
  metric text not null default 'reply_rate',
  population text not null default 'default',
  control jsonb not null default '{}'::jsonb check (jsonb_typeof(control) = 'object'),
  variant jsonb not null default '{}'::jsonb check (jsonb_typeof(variant) = 'object'),
  duration_ms bigint not null default 604800000 check (duration_ms > 0),
  sample_limit integer not null default 100 check (sample_limit between 2 and 10000),
  risk_limit numeric not null default 0.1 check (risk_limit >= 0 and risk_limit <= 1),
  success_threshold numeric not null default 0.05 check (success_threshold >= 0 and success_threshold <= 1),
  rollback_condition jsonb not null default '{}'::jsonb check (jsonb_typeof(rollback_condition) = 'object'),
  status text not null default 'running'
    check (status in ('running', 'completed', 'rolled_back', 'stopped')),
  samples jsonb not null default '{}'::jsonb check (jsonb_typeof(samples) = 'object'),
  evaluation jsonb not null default '{}'::jsonb check (jsonb_typeof(evaluation) = 'object'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.lia_regressions (
  id uuid primary key default gen_random_uuid(),
  problem_pattern text not null,
  expected_behavior text not null,
  forbidden_behavior text not null,
  test_reference text not null default '',
  status text not null default 'active'
    check (status in ('candidate', 'active', 'verified', 'deprecated')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lia_relationships (
  id text primary key,
  subject text not null,
  tenant_scope text not null default 'default',
  preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(preferences) = 'object'),
  best_hours jsonb not null default '[]'::jsonb check (jsonb_typeof(best_hours) = 'array'),
  interests jsonb not null default '[]'::jsonb check (jsonb_typeof(interests) = 'array'),
  objections jsonb not null default '[]'::jsonb check (jsonb_typeof(objections) = 'array'),
  response_patterns jsonb not null default '{}'::jsonb check (jsonb_typeof(response_patterns) = 'object'),
  commercial_stage text not null default '',
  sensitivity text not null default 'normal',
  contact_frequency text not null default 'normal',
  last_interaction_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lia_improvement_proposals (
  id uuid primary key default gen_random_uuid(),
  proposal_type text not null,
  summary text not null,
  rationale text not null default '',
  status text not null default 'pending_human_review'
    check (status in ('pending_human_review', 'approved', 'rejected', 'implemented')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'lia_experiences',
    'lia_knowledge',
    'lia_hypotheses',
    'lia_strategies',
    'lia_experiments',
    'lia_regressions',
    'lia_relationships',
    'lia_improvement_proposals'
  ] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on public.%I from public', tbl);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', tbl);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', tbl);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on public.%I to service_role', tbl);
    end if;
  end loop;
end $$;

commit;

-- ======== 20261121150000_lia_autonomy.sql ========
-- Migration: Lia Autonomy Operational Layer (Parte 3/3)
-- Rollback seguro (preserva tabelas das Partes 1 e 2):
--   drop table if exists public.lia_proactive_notifications;
--   drop table if exists public.lia_sales_states;
--   drop table if exists public.lia_autonomy_decisions;
--   drop table if exists public.lia_org_autonomy_policies;

begin;

create table if not exists public.lia_org_autonomy_policies (
  tenant_id text primary key default 'default',
  autonomy_level text not null default 'assisted'
    check (autonomy_level in ('passive', 'assisted', 'supervised_autonomous')),
  allowed_actions jsonb not null default '[]'::jsonb check (jsonb_typeof(allowed_actions) = 'array'),
  approval_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(approval_policy) = 'object'),
  daily_limits jsonb not null default '{}'::jsonb check (jsonb_typeof(daily_limits) = 'object'),
  business_hours jsonb not null default '{}'::jsonb check (jsonb_typeof(business_hours) = 'object'),
  communication_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(communication_policy) = 'object'),
  learning_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(learning_policy) = 'object'),
  experiment_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(experiment_policy) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.lia_autonomy_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  event_id uuid,
  goal_id uuid,
  decision_action text not null,
  why text not null,
  proposed_action text not null,
  expected_outcome text not null default '',
  risk text not null default 'medium'
    check (risk in ('low', 'medium', 'high', 'critical')),
  authorization_decision text not null,
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  verification_plan text not null default '',
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'confirmed', 'failed', 'uncertain', 'partial')),
  audit_chain jsonb not null default '{}'::jsonb check (jsonb_typeof(audit_chain) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists lia_autonomy_decisions_tenant_idx
  on public.lia_autonomy_decisions (tenant_id, created_at desc);

create table if not exists public.lia_sales_states (
  id text primary key,
  tenant_id text not null default 'default',
  subject text not null,
  stage text not null default 'new'
    check (stage in ('new', 'researched', 'contacted', 'engaged', 'qualified', 'opportunity', 'proposal', 'negotiation', 'won', 'lost')),
  score integer not null default 0 check (score between 0 and 100),
  score_factors jsonb not null default '{}'::jsonb check (jsonb_typeof(score_factors) = 'object'),
  next_action text not null default '',
  transitions jsonb not null default '[]'::jsonb check (jsonb_typeof(transitions) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  updated_at timestamptz not null default now()
);

create index if not exists lia_sales_states_tenant_stage_idx
  on public.lia_sales_states (tenant_id, stage, score desc);

create table if not exists public.lia_proactive_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  deduplication_key text not null unique,
  subject text not null default '',
  reason text not null,
  status text not null default 'sent'
    check (status in ('sent', 'suppressed', 'deferred', 'failed')),
  created_at timestamptz not null default now()
);

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'lia_org_autonomy_policies',
    'lia_autonomy_decisions',
    'lia_sales_states',
    'lia_proactive_notifications'
  ] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on public.%I from public', tbl);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', tbl);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', tbl);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on public.%I to service_role', tbl);
    end if;
  end loop;
end $$;

commit;


-- ======== 20261122100000_tracked_lia_commitments.sql ========
begin;

alter table public.lia_commitments
  add column if not exists conversation_id text not null default '',
  add column if not exists recipient_type text not null default 'owner',
  add column if not exists recipient_phone text not null default '',
  add column if not exists owner_type text not null default 'owner',
  add column if not exists category text not null default 'outro',
  add column if not exists deduplication_key text not null default '',
  add column if not exists overdue_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists failure_reason text;

alter table public.lia_commitments
  drop constraint if exists lia_commitments_status_check;

alter table public.lia_commitments
  add constraint lia_commitments_status_check
  check (status in ('pending', 'in_progress', 'fulfilled', 'failed', 'overdue', 'missed', 'uncertain', 'cancelled'));

alter table public.lia_commitments
  add constraint lia_commitments_recipient_type_check
    check (recipient_type in ('client', 'owner')),
  add constraint lia_commitments_owner_type_check
    check (owner_type in ('bot', 'owner')),
  add constraint lia_commitments_category_check
    check (category in ('financeiro', 'reclamacao', 'pedido_pessoa', 'emergencia', 'outro'));

create unique index if not exists lia_commitments_deduplication_key_uidx
  on public.lia_commitments (deduplication_key)
  where deduplication_key <> '';

create index if not exists lia_commitments_recipient_due_idx
  on public.lia_commitments (recipient_type, recipient_phone, due_at)
  where status in ('pending', 'in_progress');

-- Manter o Runtime backend-only; nenhuma permissão é concedida ao browser.
alter table public.lia_commitments enable row level security;
revoke all on public.lia_commitments from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.lia_commitments from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.lia_commitments from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.lia_commitments to service_role;
  end if;
end $$;

commit;


-- ======== 20261122120000_copilot_task_reconciliation.sql ========
begin;

alter table public.copilot_tasks
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciled_by text,
  add column if not exists reconciliation_outcome text,
  add column if not exists reconciliation_note text;

alter table public.copilot_tasks
  drop constraint if exists copilot_tasks_reconciliation_outcome_check;

alter table public.copilot_tasks
  add constraint copilot_tasks_reconciliation_outcome_check
  check (
    reconciliation_outcome is null
    or reconciliation_outcome in (
      'confirmed_succeeded',
      'confirmed_failed',
      'notification_confirmed_sent',
      'notification_confirmed_not_sent',
      'still_uncertain'
    )
  );

create index if not exists copilot_tasks_uncertain_reconciliation_idx
  on public.copilot_tasks (updated_at desc)
  where status = 'uncertain' or notification_status = 'uncertain';

alter table public.copilot_tasks enable row level security;
revoke all on public.copilot_tasks from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.copilot_tasks from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.copilot_tasks from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.copilot_tasks to service_role';
  end if;
end $$;

commit;

-- ======== 20261126194000_contact_ai_context_and_crm_fields.sql ========
alter table if exists public.contacts
  add column if not exists ai_context text,
  add column if not exists email text,
  add column if not exists deal_value numeric(12,2) default 0,
  add column if not exists funnel_stage text default 'novo',
  add column if not exists sector_id text,
  add column if not exists tags text[] default '{}'::text[],
  add column if not exists metadata jsonb default '{}'::jsonb;
