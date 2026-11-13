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
