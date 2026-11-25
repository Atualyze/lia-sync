-- Isola a função privilegiada usada pelas policies do painel e cobre FKs
-- sem índice. O schema private não deve ser exposto na Data API.
begin;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create or replace function private.is_active_staff(required_roles text[] default null)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $function$
begin
  return exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active = true
      and (required_roles is null or p.role = any(required_roles))
  );
end;
$function$;

revoke all on function private.is_active_staff(text[]) from public, anon, authenticated, service_role;
grant execute on function private.is_active_staff(text[]) to authenticated, service_role;

-- Mantém o nome usado pelas 12 policies já existentes, mas a função pública
-- agora executa como caller e delega somente a checagem booleana ao helper privado.
create or replace function public.is_active_staff(required_roles text[] default null)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public, private, pg_temp
as $function$
  select private.is_active_staff(required_roles);
$function$;

revoke all on function public.is_active_staff(text[]) from public, anon;
grant execute on function public.is_active_staff(text[]) to authenticated, service_role;

-- Índices de apoio a JOINs e verificações de FK. Os parciais omitem linhas
-- sem referência e mantêm menor custo de armazenamento/escrita.
create index if not exists ai_calls_conversation_id_idx
  on public.ai_calls (conversation_id) where conversation_id is not null;
create index if not exists audit_log_actor_idx
  on public.audit_log (actor) where actor is not null;
create index if not exists bot_config_revisions_actor_idx
  on public.bot_config_revisions (actor) where actor is not null;
create index if not exists bot_config_state_updated_by_idx
  on public.bot_config_state (updated_by) where updated_by is not null;
create index if not exists campaigns_created_by_idx
  on public.campaigns (created_by) where created_by is not null;
create index if not exists conversation_events_actor_profile_id_idx
  on public.conversation_events (actor_profile_id) where actor_profile_id is not null;
create index if not exists handoffs_assigned_to_idx
  on public.handoffs (assigned_to) where assigned_to is not null;
create index if not exists handoffs_conversation_id_idx
  on public.handoffs (conversation_id);
create index if not exists lia_commitments_goal_id_idx
  on public.lia_commitments (goal_id) where goal_id is not null;
create index if not exists lia_experiences_goal_id_idx
  on public.lia_experiences (goal_id) where goal_id is not null;
create index if not exists lia_experiments_hypothesis_id_idx
  on public.lia_experiments (hypothesis_id) where hypothesis_id is not null;
create index if not exists payment_orders_conversation_id_idx
  on public.payment_orders (conversation_id) where conversation_id is not null;
create index if not exists prospect_cadences_list_id_idx
  on public.prospect_cadences (list_id);
create index if not exists prospect_events_lead_id_idx
  on public.prospect_events (lead_id) where lead_id is not null;

comment on schema private is 'Funções privilegiadas internas; não expor na Data API.';
comment on function private.is_active_staff(text[]) is
  'Helper SECURITY DEFINER privado chamado pelo wrapper SECURITY INVOKER usado nas policies do painel.';

commit;
