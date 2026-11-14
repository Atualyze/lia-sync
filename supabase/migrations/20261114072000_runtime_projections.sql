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
