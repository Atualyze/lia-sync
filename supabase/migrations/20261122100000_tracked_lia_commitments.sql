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
