-- LIA Sync — limpeza de dados operacionais
-- -----------------------------------------------------------------------------
-- Objetivo:
--   Remover dados operacionais/históricos do ambiente, preservando configuração,
--   parâmetros, políticas, identidade e demais dados de configuração da Lia.
--
-- IMPORTANTE:
--   1. Este SQL é DESTRUTIVO. Execute somente em um ambiente que deve ser
--      reinicializado sem os dados operacionais atuais.
--   2. Não altera schema nem remove tabelas.
--   3. Não remove:
--      - bot_config_state
--      - bot_config_revisions
--      - workspace_settings
--      - user_settings
--      - profiles
--      - faq
--      - lia_identity
--      - lia_knowledge
--      - lia_strategies
--      - lia_hypotheses
--      - lia_regressions
--      - lia_org_autonomy_policies
--   4. phone_suppressions é limpa neste reset para reproduzir exatamente o
--      "ambiente limpo" atual. Em produção, avalie preservar opt-outs antes de
--      executar este arquivo.
--   5. payment_orders e audit_log são históricos operacionais e também são
--      apagados por este reset. Se houver requisito legal/financeiro de retenção,
--      remova essas duas instruções antes de executar.
--
-- A ordem abaixo respeita as dependências de chave estrangeira conhecidas.

BEGIN;

-- Conversas, contatos e histórico de atendimento.
DELETE FROM public.conversation_messages;
DELETE FROM public.conversation_events;
DELETE FROM public.handoffs;
DELETE FROM public.ai_calls;
DELETE FROM public.payment_orders;
DELETE FROM public.conversations;
DELETE FROM public.contacts;

-- Lembretes e fila persistente do Copilot.
DELETE FROM public.reminders;
DELETE FROM public.copilot_tasks;

-- Observabilidade, auditoria e estado transitório.
DELETE FROM public.audit_log;
DELETE FROM public.webhook_events;
DELETE FROM public.idempotency_keys;
DELETE FROM public.ai_budget_reservations;
DELETE FROM public.runtime_projections;
DELETE FROM public.phone_suppressions;

-- Campanhas e prospecção.
DELETE FROM public.campaign_recipients;
DELETE FROM public.campaigns;
DELETE FROM public.prospect_events;
DELETE FROM public.prospect_leads;
DELETE FROM public.prospect_cadences;
DELETE FROM public.prospect_lists;

-- Estado operacional/atividade persistente da Lia.
DELETE FROM public.lia_proactive_notifications;
DELETE FROM public.lia_autonomy_decisions;
DELETE FROM public.lia_sales_states;
DELETE FROM public.lia_commitments;
DELETE FROM public.lia_experiences;
DELETE FROM public.lia_experiments;
DELETE FROM public.lia_events;
DELETE FROM public.lia_goals;
DELETE FROM public.lia_runtime_state;
DELETE FROM public.lia_improvement_proposals;

COMMIT;

-- Verificação rápida: as tabelas operacionais acima devem retornar 0.
SELECT table_name, row_count
FROM (
  SELECT 'contacts' AS table_name, count(*)::bigint AS row_count FROM public.contacts
  UNION ALL SELECT 'conversations', count(*) FROM public.conversations
  UNION ALL SELECT 'conversation_messages', count(*) FROM public.conversation_messages
  UNION ALL SELECT 'reminders', count(*) FROM public.reminders
  UNION ALL SELECT 'ai_calls', count(*) FROM public.ai_calls
  UNION ALL SELECT 'audit_log', count(*) FROM public.audit_log
  UNION ALL SELECT 'webhook_events', count(*) FROM public.webhook_events
  UNION ALL SELECT 'copilot_tasks', count(*) FROM public.copilot_tasks
  UNION ALL SELECT 'payment_orders', count(*) FROM public.payment_orders
  UNION ALL SELECT 'prospect_leads', count(*) FROM public.prospect_leads
  UNION ALL SELECT 'lia_runtime_state', count(*) FROM public.lia_runtime_state
) AS cleanup_check
ORDER BY table_name;
