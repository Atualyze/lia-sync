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
