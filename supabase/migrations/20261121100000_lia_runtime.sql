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
