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
