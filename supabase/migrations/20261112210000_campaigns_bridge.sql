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
