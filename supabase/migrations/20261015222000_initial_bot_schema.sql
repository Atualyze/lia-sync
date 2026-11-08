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
