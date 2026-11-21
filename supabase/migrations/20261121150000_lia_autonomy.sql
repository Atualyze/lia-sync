-- Migration: Lia Autonomy Operational Layer (Parte 3/3)
-- Rollback seguro (preserva tabelas das Partes 1 e 2):
--   drop table if exists public.lia_proactive_notifications;
--   drop table if exists public.lia_sales_states;
--   drop table if exists public.lia_autonomy_decisions;
--   drop table if exists public.lia_org_autonomy_policies;

begin;

create table if not exists public.lia_org_autonomy_policies (
  tenant_id text primary key default 'default',
  autonomy_level text not null default 'assisted'
    check (autonomy_level in ('passive', 'assisted', 'supervised_autonomous')),
  allowed_actions jsonb not null default '[]'::jsonb check (jsonb_typeof(allowed_actions) = 'array'),
  approval_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(approval_policy) = 'object'),
  daily_limits jsonb not null default '{}'::jsonb check (jsonb_typeof(daily_limits) = 'object'),
  business_hours jsonb not null default '{}'::jsonb check (jsonb_typeof(business_hours) = 'object'),
  communication_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(communication_policy) = 'object'),
  learning_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(learning_policy) = 'object'),
  experiment_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(experiment_policy) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.lia_autonomy_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  event_id uuid,
  goal_id uuid,
  decision_action text not null,
  why text not null,
  proposed_action text not null,
  expected_outcome text not null default '',
  risk text not null default 'medium'
    check (risk in ('low', 'medium', 'high', 'critical')),
  authorization_decision text not null,
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  verification_plan text not null default '',
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'confirmed', 'failed', 'uncertain', 'partial')),
  audit_chain jsonb not null default '{}'::jsonb check (jsonb_typeof(audit_chain) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists lia_autonomy_decisions_tenant_idx
  on public.lia_autonomy_decisions (tenant_id, created_at desc);

create table if not exists public.lia_sales_states (
  id text primary key,
  tenant_id text not null default 'default',
  subject text not null,
  stage text not null default 'new'
    check (stage in ('new', 'researched', 'contacted', 'engaged', 'qualified', 'opportunity', 'proposal', 'negotiation', 'won', 'lost')),
  score integer not null default 0 check (score between 0 and 100),
  score_factors jsonb not null default '{}'::jsonb check (jsonb_typeof(score_factors) = 'object'),
  next_action text not null default '',
  transitions jsonb not null default '[]'::jsonb check (jsonb_typeof(transitions) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  updated_at timestamptz not null default now()
);

create index if not exists lia_sales_states_tenant_stage_idx
  on public.lia_sales_states (tenant_id, stage, score desc);

create table if not exists public.lia_proactive_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  deduplication_key text not null unique,
  subject text not null default '',
  reason text not null,
  status text not null default 'sent'
    check (status in ('sent', 'suppressed', 'deferred', 'failed')),
  created_at timestamptz not null default now()
);

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'lia_org_autonomy_policies',
    'lia_autonomy_decisions',
    'lia_sales_states',
    'lia_proactive_notifications'
  ] loop
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
