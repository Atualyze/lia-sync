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
