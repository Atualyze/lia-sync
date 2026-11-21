begin;

create table if not exists public.lia_experiences (
  id uuid primary key default gen_random_uuid(),
  deduplication_key text not null unique,
  occurred_at timestamptz not null default now(),
  actor text not null default 'runtime',
  source text not null default 'system',
  scope text not null default 'business'
    check (scope in ('individual', 'relationship', 'business', 'segment', 'global')),
  subject text not null default '',
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  goal_id uuid references public.lia_goals(id) on delete set null,
  task_id uuid,
  action text not null default '',
  expected_result text not null default '',
  actual_result text not null default '',
  outcome text not null default 'uncertain'
    check (outcome in ('success', 'partial_success', 'failure', 'uncertain', 'abandoned')),
  feedback jsonb not null default '[]'::jsonb check (jsonb_typeof(feedback) = 'array'),
  error text,
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  significance text not null default 'medium'
    check (significance in ('low', 'medium', 'high', 'critical')),
  reflected boolean not null default false,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lia_experiences_unreflected_idx
  on public.lia_experiences (reflected, significance, occurred_at desc);

create table if not exists public.lia_knowledge (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'inference'
    check (kind in ('fact', 'inference', 'hypothesis', 'strategy', 'rule', 'preference')),
  scope text not null default 'business'
    check (scope in ('individual', 'relationship', 'business', 'segment', 'global')),
  subject text not null default '',
  topic text not null default '',
  content text not null,
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  evidence_count integer not null default 1 check (evidence_count >= 0),
  positive_evidence integer not null default 0 check (positive_evidence >= 0),
  negative_evidence integer not null default 0 check (negative_evidence >= 0),
  last_validated_at timestamptz,
  last_invalidated_at timestamptz,
  status text not null default 'candidate'
    check (status in ('candidate', 'experimental', 'supported', 'consolidated', 'deprecated', 'contradicted')),
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lia_knowledge_scope_status_idx
  on public.lia_knowledge (scope, status, confidence desc);

create table if not exists public.lia_hypotheses (
  id uuid primary key default gen_random_uuid(),
  statement text not null,
  scope text not null default 'business'
    check (scope in ('individual', 'relationship', 'business', 'segment', 'global')),
  metric text not null default 'reply_rate',
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  positive_evidence integer not null default 0 check (positive_evidence >= 0),
  negative_evidence integer not null default 0 check (negative_evidence >= 0),
  status text not null default 'candidate'
    check (status in ('candidate', 'experimental', 'supported', 'consolidated', 'deprecated', 'contradicted')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lia_strategies (
  id uuid primary key default gen_random_uuid(),
  strategy_key text not null,
  version integer not null default 1 check (version >= 1),
  scope text not null default 'business'
    check (scope in ('individual', 'relationship', 'business', 'segment', 'global')),
  status text not null default 'draft'
    check (status in ('draft', 'experimental', 'active', 'deprecated', 'disabled')),
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  definition jsonb not null default '{}'::jsonb check (jsonb_typeof(definition) = 'object'),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (strategy_key, version, scope)
);

create table if not exists public.lia_experiments (
  id uuid primary key default gen_random_uuid(),
  hypothesis_id uuid references public.lia_hypotheses(id) on delete set null,
  metric text not null default 'reply_rate',
  population text not null default 'default',
  control jsonb not null default '{}'::jsonb check (jsonb_typeof(control) = 'object'),
  variant jsonb not null default '{}'::jsonb check (jsonb_typeof(variant) = 'object'),
  duration_ms bigint not null default 604800000 check (duration_ms > 0),
  sample_limit integer not null default 100 check (sample_limit between 2 and 10000),
  risk_limit numeric not null default 0.1 check (risk_limit >= 0 and risk_limit <= 1),
  success_threshold numeric not null default 0.05 check (success_threshold >= 0 and success_threshold <= 1),
  rollback_condition jsonb not null default '{}'::jsonb check (jsonb_typeof(rollback_condition) = 'object'),
  status text not null default 'running'
    check (status in ('running', 'completed', 'rolled_back', 'stopped')),
  samples jsonb not null default '{}'::jsonb check (jsonb_typeof(samples) = 'object'),
  evaluation jsonb not null default '{}'::jsonb check (jsonb_typeof(evaluation) = 'object'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.lia_regressions (
  id uuid primary key default gen_random_uuid(),
  problem_pattern text not null,
  expected_behavior text not null,
  forbidden_behavior text not null,
  test_reference text not null default '',
  status text not null default 'active'
    check (status in ('candidate', 'active', 'verified', 'deprecated')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lia_relationships (
  id text primary key,
  subject text not null,
  tenant_scope text not null default 'default',
  preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(preferences) = 'object'),
  best_hours jsonb not null default '[]'::jsonb check (jsonb_typeof(best_hours) = 'array'),
  interests jsonb not null default '[]'::jsonb check (jsonb_typeof(interests) = 'array'),
  objections jsonb not null default '[]'::jsonb check (jsonb_typeof(objections) = 'array'),
  response_patterns jsonb not null default '{}'::jsonb check (jsonb_typeof(response_patterns) = 'object'),
  commercial_stage text not null default '',
  sensitivity text not null default 'normal',
  contact_frequency text not null default 'normal',
  last_interaction_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lia_improvement_proposals (
  id uuid primary key default gen_random_uuid(),
  proposal_type text not null,
  summary text not null,
  rationale text not null default '',
  status text not null default 'pending_human_review'
    check (status in ('pending_human_review', 'approved', 'rejected', 'implemented')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'lia_experiences',
    'lia_knowledge',
    'lia_hypotheses',
    'lia_strategies',
    'lia_experiments',
    'lia_regressions',
    'lia_relationships',
    'lia_improvement_proposals'
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
