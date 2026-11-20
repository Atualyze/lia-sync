begin;

create table if not exists public.copilot_tasks (
  id uuid primary key default gen_random_uuid(),
  task_key text not null unique,
  owner_key text not null,
  target_phone text,
  request_summary text not null default '',
  actor_label text not null default 'responsável',
  steps jsonb not null check (
    jsonb_typeof(steps) = 'array'
    and jsonb_array_length(steps) between 1 and 4
  ),
  retry_policy text not null default 'never'
    check (retry_policy in ('read_only', 'never')),
  constraint copilot_tasks_pix_never_retries check (
    retry_policy <> 'read_only'
    or not (steps @> '[{"name":"gerar_cobranca_pix"}]'::jsonb)
  ),
  constraint copilot_tasks_pix_single_step check (
    not (steps @> '[{"name":"gerar_cobranca_pix"}]'::jsonb)
    or jsonb_array_length(steps) = 1
  ),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'awaiting_input', 'succeeded', 'failed', 'uncertain', 'cancelled')),
  result_text text,
  result_summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result_summary) = 'object'),
  last_error_code text,
  current_step integer not null default 0 check (current_step between 0 and 4),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 1 check (max_attempts between 1 and 3),
  available_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '6 hours'),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  notification_status text not null default 'pending'
    check (notification_status in ('pending', 'sending', 'sent', 'uncertain', 'unaddressable')),
  notified_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint copilot_tasks_lease_consistency check (
    (status = 'running' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'running')
  )
);

create index if not exists copilot_tasks_queue_idx
  on public.copilot_tasks (status, available_at, created_at)
  where status = 'queued';

create index if not exists copilot_tasks_owner_idx
  on public.copilot_tasks (owner_key, created_at desc);

create index if not exists copilot_tasks_lease_idx
  on public.copilot_tasks (lease_expires_at)
  where status = 'running';

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

create or replace function public.claim_copilot_task(
  p_worker text,
  p_lease_seconds integer default 180
)
returns setof public.copilot_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_task public.copilot_tasks;
begin
  -- Uma execução interrompida pode voltar à fila apenas quando a ferramenta
  -- é estritamente somente-leitura. Efeitos externos/artifacts viram incertos.
  update public.copilot_tasks
  set
    status = case
      when retry_policy = 'read_only' and attempt_count < max_attempts then 'queued'
      when retry_policy = 'read_only' then 'failed'
      else 'uncertain'
    end,
    last_error_code = case
      when retry_policy = 'read_only' and attempt_count < max_attempts then 'read_only_lease_expired'
      when retry_policy = 'read_only' then 'read_only_attempts_exhausted'
      else 'execution_lease_expired'
    end,
    result_text = case
      when retry_policy = 'read_only' and attempt_count < max_attempts then result_text
      when retry_policy = 'read_only' then 'A consulta foi interrompida após atingir o limite de tentativas seguras. Nenhuma ação externa foi repetida.'
      else 'A execução foi interrompida e o resultado ficou incerto. É necessária uma conferência antes de qualquer nova tentativa.'
    end,
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now(),
    completed_at = case
      when retry_policy = 'read_only' and attempt_count < max_attempts then null
      else now()
    end
  where status = 'running'
    and lease_expires_at <= now();

  -- Uma notificação pode ter sido aceita pelo WhatsApp antes da queda.
  -- Nunca liberamos novamente uma entrega cujo resultado seja incerto.
  update public.copilot_tasks
  set
    notification_status = 'uncertain',
    last_error_code = 'notification_lease_expired',
    updated_at = now()
  where status in ('succeeded', 'failed', 'uncertain')
    and notification_status = 'sending'
    and updated_at <= now() - interval '2 minutes';

  update public.copilot_tasks
  set
    status = 'failed',
    last_error_code = 'task_expired_before_execution',
    result_text = 'A tarefa expirou antes de começar. Nenhuma ferramenta foi executada.',
    completed_at = now(),
    updated_at = now()
  where status = 'queued'
    and expires_at <= now();

  select id into v_id
  from public.copilot_tasks
  where status = 'queued'
    and available_at <= now()
    and expires_at > now()
    and attempt_count < max_attempts
  order by created_at asc
  limit 1
  for update skip locked;

  if v_id is null then
    return;
  end if;

  update public.copilot_tasks
  set
    status = 'running',
    attempt_count = attempt_count + 1,
    lease_owner = left(coalesce(nullif(p_worker, ''), 'lia-worker'), 120),
    lease_token = gen_random_uuid(),
    lease_expires_at = now() + make_interval(secs => greatest(30, least(600, coalesce(p_lease_seconds, 180)))),
    started_at = coalesce(started_at, now()),
    updated_at = now()
  where id = v_id
  returning * into v_task;

  return next v_task;
end;
$$;

revoke all on function public.claim_copilot_task(text, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.claim_copilot_task(text, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.claim_copilot_task(text, integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.claim_copilot_task(text, integer) to service_role';
  end if;
end $$;

comment on table public.copilot_tasks is
  'Fila persistente do Copiloto. Acesso backend-only; argumentos e resultados nunca são expostos ao browser.';
comment on function public.claim_copilot_task(text, integer) is
  'Reivindica uma tarefa em transação com SKIP LOCKED. Reexecuta somente-leitura após lease expirado; efeitos externos ficam incertos. Service-role only.';

commit;
