-- Durable Copilot task queue.
-- RLS without browser policies keeps requests, tool arguments and results service-role only.
begin;

create table if not exists public.copilot_tasks (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  actor_role text not null default 'owner',
  actor_label text not null default 'responsável',
  task_type text not null default 'consultation',
  request_text text not null default '',
  steps jsonb not null default '[]'::jsonb,
  current_step integer not null default 0,
  status text not null default 'queued',
  result jsonb,
  last_error text,
  delivery_status text not null default 'pending',
  delivery_error text,
  worker_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint copilot_tasks_status_check
    check (status in ('queued','running','awaiting_input','succeeded','failed','uncertain','cancelled')),
  constraint copilot_tasks_delivery_status_check
    check (delivery_status in ('pending','sending','sent','uncertain','skipped')),
  constraint copilot_tasks_current_step_nonnegative check (current_step >= 0),
  constraint copilot_tasks_attempt_nonnegative check (attempt_count >= 0),
  constraint copilot_tasks_steps_array check (
    jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 4
  )
);

create index if not exists copilot_tasks_queue_idx
  on public.copilot_tasks (status, created_at)
  where status = 'queued';

create index if not exists copilot_tasks_owner_recent_idx
  on public.copilot_tasks (actor_role, created_at desc);

create index if not exists copilot_tasks_expired_lease_idx
  on public.copilot_tasks (status, lease_expires_at)
  where status = 'running';

alter table public.copilot_tasks enable row level security;

revoke all on table public.copilot_tasks from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.copilot_tasks from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.copilot_tasks from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on table public.copilot_tasks to service_role';
  end if;
end $$;

create or replace function public.claim_copilot_task(
  p_worker text,
  p_lease_seconds integer default 90
) returns setof public.copilot_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_worker text := left(nullif(btrim(coalesce(p_worker, '')), ''), 120);
  v_lease integer := greatest(60, least(coalesce(p_lease_seconds, 90), 300));
begin
  if v_worker is null then
    return;
  end if;

  -- A crashed read-only/static-artifact step can safely resume. A non-replayable
  -- running step is converted to uncertain and never dispatched again.
  update public.copilot_tasks t
  set status = case
        when t.current_step > 0
          and coalesce(t.steps -> (t.current_step - 1) ->> 'state', '') = 'running'
          and coalesce(t.steps -> (t.current_step - 1) ->> 'recovery_mode', '') <> 'safe'
          then 'uncertain'
        else 'queued'
      end,
      last_error = case
        when t.current_step > 0
          and coalesce(t.steps -> (t.current_step - 1) ->> 'state', '') = 'running'
          and coalesce(t.steps -> (t.current_step - 1) ->> 'recovery_mode', '') <> 'safe'
          then 'Lease expirou durante uma etapa que não pode ser repetida com segurança.'
        else t.last_error
      end,
      lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      updated_at = now()
  where t.status = 'running'
    and t.lease_expires_at < now();

  -- Sending a WhatsApp result is itself a side effect. A crash after the provider
  -- accepted it must not cause a blind duplicate.
  update public.copilot_tasks
  set delivery_status = 'uncertain',
      delivery_error = coalesce(delivery_error, 'Worker interrompido durante a entrega; confirmar no WhatsApp antes de reenviar.'),
      updated_at = now()
  where delivery_status = 'sending'
    and updated_at < now() - interval '5 minutes';

  return query
  with candidate as (
    select id
    from public.copilot_tasks
    where status = 'queued'
    order by created_at asc
    limit 1
    for update skip locked
  )
  update public.copilot_tasks t
  set status = 'running',
      worker_id = v_worker,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => v_lease),
      attempt_count = t.attempt_count + 1,
      started_at = coalesce(t.started_at, now()),
      updated_at = now()
  from candidate c
  where t.id = c.id
  returning t.*;
end;
$$;

create or replace function public.renew_copilot_task_lease(
  p_task_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 90
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows integer;
begin
  update public.copilot_tasks
  set lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 90), 300))),
      updated_at = now()
  where id = p_task_id and lease_token = p_lease_token and status = 'running';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create or replace function public.checkpoint_copilot_task_step(
  p_task_id uuid,
  p_lease_token uuid,
  p_step_index integer,
  p_state text,
  p_result jsonb default null,
  p_error text default ''
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
  v_index integer := p_step_index - 1;
  v_step jsonb;
begin
  if p_step_index < 1 or p_state not in ('running','succeeded','failed','uncertain','awaiting_input') then
    return false;
  end if;

  update public.copilot_tasks t
  set steps = jsonb_set(
        t.steps,
        array[v_index::text],
        coalesce(t.steps -> v_index, '{}'::jsonb)
          || jsonb_build_object(
            'state', p_state,
            'updated_at', now(),
            'started_at', case when p_state = 'running' then to_jsonb(now()) else coalesce(t.steps -> v_index -> 'started_at', to_jsonb(now())) end,
            'completed_at', case when p_state in ('succeeded','failed','uncertain','awaiting_input') then to_jsonb(now()) else t.steps -> v_index -> 'completed_at' end,
            'result', case when p_result is null then t.steps -> v_index -> 'result' else p_result end,
            'error', nullif(left(coalesce(p_error, ''), 500), '')
          ),
        true
      ),
      current_step = p_step_index,
      updated_at = now()
  where t.id = p_task_id
    and t.lease_token = p_lease_token
    and t.status = 'running'
    and jsonb_typeof(t.steps -> v_index) = 'object';

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create or replace function public.finish_copilot_task(
  p_task_id uuid,
  p_lease_token uuid,
  p_status text,
  p_result jsonb default null,
  p_error text default ''
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows integer;
begin
  if p_status not in ('awaiting_input','succeeded','failed','uncertain') then
    return false;
  end if;
  update public.copilot_tasks
  set status = p_status,
      result = coalesce(p_result, result),
      last_error = nullif(left(coalesce(p_error, ''), 500), ''),
      completed_at = case when p_status in ('succeeded','failed','uncertain') then now() else null end,
      lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      updated_at = now()
  where id = p_task_id and lease_token = p_lease_token and status = 'running';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create or replace function public.cancel_copilot_task(p_task_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $
declare v_rows integer;
begin
  update public.copilot_tasks
  set status = 'cancelled',
      last_error = 'Cancelada explicitamente pelo responsável.',
      completed_at = now(),
      lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      updated_at = now()
  where id = p_task_id
    and status in ('queued','running','awaiting_input');
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$;

create or replace function public.begin_copilot_task_delivery(p_task_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows integer;
begin
  update public.copilot_tasks
  set delivery_status = 'sending', delivery_error = null, updated_at = now()
  where id = p_task_id
    and status in ('succeeded','failed','awaiting_input','uncertain')
    and delivery_status = 'pending';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create or replace function public.finish_copilot_task_delivery(
  p_task_id uuid,
  p_status text,
  p_error text default ''
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows integer;
begin
  if p_status not in ('sent','uncertain','skipped') then
    return false;
  end if;
  update public.copilot_tasks
  set delivery_status = p_status,
      delivery_error = nullif(left(coalesce(p_error, ''), 300), ''),
      updated_at = now()
  where id = p_task_id and delivery_status = 'sending';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.claim_copilot_task(text, integer) from public, anon, authenticated;
revoke all on function public.renew_copilot_task_lease(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.checkpoint_copilot_task_step(uuid, uuid, integer, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.finish_copilot_task(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.cancel_copilot_task(uuid) from public, anon, authenticated;
revoke all on function public.begin_copilot_task_delivery(uuid) from public, anon, authenticated;
revoke all on function public.finish_copilot_task_delivery(uuid, text, text) from public, anon, authenticated;

grant execute on function public.claim_copilot_task(text, integer) to service_role;
grant execute on function public.renew_copilot_task_lease(uuid, uuid, integer) to service_role;
grant execute on function public.checkpoint_copilot_task_step(uuid, uuid, integer, text, jsonb, text) to service_role;
grant execute on function public.finish_copilot_task(uuid, uuid, text, jsonb, text) to service_role;
grant execute on function public.cancel_copilot_task(uuid) to service_role;
grant execute on function public.begin_copilot_task_delivery(uuid) to service_role;
grant execute on function public.finish_copilot_task_delivery(uuid, text, text) to service_role;

comment on table public.copilot_tasks is
  'Fila durável do Copiloto. Argumentos/resultados são dados operacionais internos; RLS sem policies, acesso apenas service_role.';

commit;
