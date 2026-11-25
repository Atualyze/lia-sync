-- Hardening da superfície Data API para tabelas internas do runtime.
-- O backend usa SUPABASE_SERVICE_ROLE_KEY apenas no servidor; essas tabelas
-- não devem conceder privilégios a anon/authenticated/PUBLIC.
begin;

revoke all privileges on table
  public.idempotency_keys,
  public.payment_orders,
  public.phone_suppressions,
  public.runtime_projections,
  public.webhook_events
from public, anon, authenticated;

-- Usada pelas policies do painel: mantém acesso apenas para usuários autenticados
-- e service_role. auth.uid() continua sendo o vínculo de identidade da equipe.
revoke all privileges on function public.is_active_staff(text[]) from public, anon;
grant execute on function public.is_active_staff(text[]) to authenticated, service_role;
alter function public.is_active_staff(text[]) set search_path = pg_catalog, public, pg_temp;

-- Função interna de event trigger; não é uma RPC pública nem deve ser
-- executável por visitantes ou usuários do painel.
revoke all privileges on function public.rls_auto_enable() from public, anon, authenticated;

-- A chave primária em phone já garante unicidade; o índice abaixo era duplicado.
drop index if exists public.phone_suppressions_phone_uidx;

comment on table public.payment_orders is
  'Pedidos de pagamento; backend/service_role only, sem acesso direto pela Data API pública.';
comment on table public.idempotency_keys is
  'Chaves e respostas idempotentes; backend/service_role only.';
comment on table public.runtime_projections is
  'Projeções internas do runtime; backend/service_role only.';
comment on table public.webhook_events is
  'Ledger sanitizado de webhooks; backend/service_role only.';
comment on table public.phone_suppressions is
  'Fonte canônica backend-only de opt-out por telefone.';

commit;
