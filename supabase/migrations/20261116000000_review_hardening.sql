-- Lia Sync — endurecimento de persistência, jobs e banco (revisão de 2026-11-16).
--
-- Aditiva e idempotente: pode ser aplicada em bancos que já executaram as migrations
-- anteriores sem recriar nada, e em bancos parcialmente migrados (usa to_regclass /
-- add column if not exists). Não executa automaticamente; revisar e aplicar de forma
-- explícita, como as demais migrations deste diretório.
--
-- Conteúdo:
--   a) RLS (sem policies) nas quatro tabelas de prospecção — service-role only.
--   b) conversations.legal_hold — flag de retenção que o flush de sessão não sobrescreve.
--   c) tabela public.reminders alinhada ao runtime, com created_by sem CHECK restritivo.
--   d) RPC claim_maintenance_lease — lease distribuído para o loop de manutenção.
begin;

-- ---------------------------------------------------------------------------
-- (a) Prospecção: PII de leads nunca pode ser lida com a chave publishable.
--
-- As tabelas foram criadas sem `enable row level security`; no Supabase isso as
-- deixa expostas ao PostgREST com as roles anon/authenticated. Habilitar RLS sem
-- criar nenhuma policy mantém o acesso exclusivo do service_role (que ignora RLS).
-- `to_regclass` mantém a migration idempotente e segura em bancos onde a migration
-- de prospecção ainda não foi aplicada.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.prospect_lists') is not null then
    execute 'alter table public.prospect_lists enable row level security';
    execute 'comment on table public.prospect_lists is ''Listas de prospecção; RLS sem policies: service-role only.''';
  end if;

  if to_regclass('public.prospect_cadences') is not null then
    execute 'alter table public.prospect_cadences enable row level security';
    execute 'comment on table public.prospect_cadences is ''Cadências de prospecção; RLS sem policies: service-role only.''';
  end if;

  if to_regclass('public.prospect_leads') is not null then
    execute 'alter table public.prospect_leads enable row level security';
    execute 'comment on table public.prospect_leads is ''Leads de prospecção (PII); RLS sem policies: service-role only.''';
    -- Suporte à recuperação de claims órfãs (lease expirado) em listDueLeads.
    execute 'create index if not exists idx_prospect_leads_claim on public.prospect_leads (status, claimed_at) where claim_token is not null';
  end if;

  if to_regclass('public.prospect_events') is not null then
    execute 'alter table public.prospect_events enable row level security';
    execute 'comment on table public.prospect_events is ''Eventos de prospecção; RLS sem policies: service-role only.''';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (b) conversations.legal_hold
--
-- O sweep de retenção precisa distinguir "pode expurgar" de "preservar por
-- obrigação legal". Hoje o único sinal é metadata->>'legalHold', que o flush de
-- sessão reescreve por inteiro a cada ciclo — logo o hold se perde. Uma coluna
-- dedicada não é tocada por sessionToConversation (outro dono) e pode ser
-- ligada/desligada sem risco de ser apagada por um flush concorrente.
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column if not exists legal_hold boolean not null default false;

comment on column public.conversations.legal_hold is
  'Impede o expurgo por retenção. Coluna dedicada: nunca derivada de metadata de sessão.';

create index if not exists conversations_legal_hold_idx
  on public.conversations (legal_hold, updated_at)
  where legal_hold;

-- ---------------------------------------------------------------------------
-- (c) public.reminders alinhada ao runtime (src/reminders.mjs)
--
-- A tabela só existia em complete_schema_migration.sql, que não é uma migration
-- versionada, e trazia `created_by ... check (created_by in ('tauan','contato','sistema'))`
-- enquanto o código grava 'lia' e 'owner'. Resultado: 23514 e nenhum lembrete
-- criado. Aqui a tabela é criada de forma versionada, o CHECK antigo é removido
-- e o default vai para o valor neutro 'sistema'.
-- ---------------------------------------------------------------------------
create table if not exists public.reminders (
  id text primary key,
  text text not null,
  due_at timestamptz not null,
  phone text,
  client_name text,
  created_by text not null default 'sistema',
  status text not null default 'pending',
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- Bancos que já têm a tabela (via complete_schema) podem estar sem alguma coluna.
alter table public.reminders add column if not exists text text;
alter table public.reminders add column if not exists due_at timestamptz;
alter table public.reminders add column if not exists phone text;
alter table public.reminders add column if not exists client_name text;
alter table public.reminders add column if not exists created_by text;
alter table public.reminders add column if not exists status text;
alter table public.reminders add column if not exists sent_at timestamptz;
alter table public.reminders add column if not exists created_at timestamptz;

alter table public.reminders alter column created_by set default 'sistema';
alter table public.reminders alter column status set default 'pending';
alter table public.reminders alter column created_at set default now();

-- O CHECK original restringia a três valores e não cobria 'lia'/'owner' do runtime.
alter table public.reminders drop constraint if exists reminders_created_by_check;

create index if not exists reminders_pending_due_idx
  on public.reminders (status, due_at)
  where status = 'pending';

alter table public.reminders enable row level security;
comment on table public.reminders is
  'Lembretes do Copiloto; RLS sem policies: service-role only. created_by é livre (lia/owner/contato/sistema).';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.reminders from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.reminders from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (d) claim_maintenance_lease — lease distribuído para o loop de manutenção.
--
-- Sem isso, cada réplica roda lembretes, aviso de janela e recuperação de
-- checkout ao mesmo tempo e o cliente recebe a mesma mensagem (link Pix incluso)
-- mais de uma vez. A reserva é atômica: só uma chamada consegue atualizar
-- runtime_projections com a chave 'maintenance_lease' enquanto o lease anterior
-- não expirou. Idempotente por natureza (ON CONFLICT), sem tabela nova.
--
-- Retorna true quando ESTA chamada obteve o lease.
-- ---------------------------------------------------------------------------
create or replace function public.claim_maintenance_lease(
  p_owner text,
  p_ttl_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner text := nullif(btrim(coalesce(p_owner, '')), '');
  v_ttl integer := greatest(30, least(coalesce(p_ttl_seconds, 300), 3600));
  v_rows integer := 0;
begin
  if v_owner is null then
    return false;
  end if;

  insert into public.runtime_projections as rp (key, payload, updated_at)
  values (
    'maintenance_lease',
    jsonb_build_object('owner', v_owner, 'acquired_at', now()),
    now()
  )
  on conflict (key) do update
    set payload = jsonb_build_object('owner', v_owner, 'acquired_at', now()),
        updated_at = now()
    where rp.updated_at < now() - make_interval(secs => v_ttl);

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.claim_maintenance_lease(text, integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.claim_maintenance_lease(text, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.claim_maintenance_lease(text, integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.claim_maintenance_lease(text, integer) to service_role';
  end if;
end $$;

comment on function public.claim_maintenance_lease(text, integer) is
  'Lease distribuído do loop de manutenção; reserva atômica em runtime_projections. Service-role only.';

commit;
