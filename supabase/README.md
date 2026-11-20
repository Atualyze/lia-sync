# Supabase independente do bot

Esta documentação acompanha o Lia Sync **2.9.0**. O desenho do runtime e das fachadas de integração está em [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

Este diretório contém o schema do banco do Lia Sync, independente do Supabase do CRM original. O runtime usa o Supabase como fonte primária quando configurado e mantém armazenamento local como fallback compatível.

## Migrações

Para um projeto novo ou ambiente ainda não migrado, aplique os arquivos SQL nesta ordem, conferindo o estado do ambiente antes de reaplicar scripts:

1. `migrations/20261015222000_initial_bot_schema.sql`
2. `migrations/20261015223000_operational_bot_schema.sql`
3. `migrations/20261016000000_faq_table.sql` — compatibilidade para bancos que já executaram as migrations anteriores
4. `migrations/20261112210000_campaigns_bridge.sql` — campanhas, destinatários e idempotência
5. `migrations/20261112220000_phone_suppressions.sql` — supressões/opt-out canônicos
6. `migrations/20261113000000_operations_observability.sql` — concorrência de campanhas e ledger sanitizado de webhooks
7. `migrations/20261113152048_follow_up_atomic_claim.sql` — claim/complete/release de follow-up distribuído
8. `migrations/20261113153840_atomic_ai_budgets.sql` — tabela de reservas e RPCs de orçamento de IA
9. `migrations/20261113154223_ai_budget_effective_model.sql` — modelo efetivo e preservação de uso desconhecido
10. `migrations/20261114072000_runtime_projections.sql` — tabela `runtime_projections` dedicada para projeções operacionais (ex.: `sectors_projection`)
11. `migrations/20261115_prospecting.sql` — listas, cadências, leads e eventos de prospecção
12. `migrations/20261115_sync_archive.sql` — `deleted_at` / soft-delete em conversas e mensagens
13. `migrations/20261116000000_review_hardening.sql` — RLS nas tabelas `prospect_*` e `reminders`, CHECK de `created_by` removido, lease de manutenção
14. `migrations/20261120150000_copilot_task_queue.sql` — fila persistente backend-only do Copiloto, leases, idempotência e notificação de resultados\n15. `seed.sql` — opcional, somente para ambiente de desenvolvimento/teste

As três migrations de follow-up/orçamento foram aplicadas e verificadas no projeto Supabase conectado durante a release 2.3.0. Em outros ambientes, confirme o histórico de migrations antes de aplicar. Não use `seed.sql` com preços de teste ativos em produção.

A migration inicial cria a camada de integração. A segunda contém o domínio operacional usado pelo runtime híbrido. As migrations posteriores acrescentam campanhas, supressões, auditoria e coordenação distribuída; elas são aditivas e não substituem a validação da configuração e do rollback do ambiente.

## Estrutura completa

### Integração e operação do atendimento

- `profiles`: autorização do dashboard, ligada a `auth.users`.
- `plans`: planos comerciais lidos pelo bot, com valores em centavos de BRL.
- `faq`: perguntas e respostas canônicas, com `active`, ordenação e palavras-chave.
- `workspace_settings`: FAQ legado em `aeo_faq`, mantido para compatibilidade.
- `workspace_preferences`: regiões, horário e fuso usados pela FAQ dinâmica.
- `contacts`, `pets`, `conversations`, `conversation_messages`: identidade e estado das conversas; `conversations` também guarda o estado persistente de follow-up.
- `handoffs`, `conversation_events`: fila de transferências e auditoria de eventos.

### Governança, campanhas e observabilidade

- `bot_config_state`, `bot_config_revisions`: rascunho, configuração ativa e histórico de publicação/rollback.
- `ai_calls`: telemetria sem prompts, respostas ou telefones completos.
- `ai_budget_reservations`: reservas e liquidações distribuídas por chamada; acesso direto bloqueado ao browser.
- `campaigns`, `campaign_recipients`, `idempotency_keys`: campanhas e execução idempotente da ponte.
- `phone_suppressions`: fonte canônica backend-only de opt-out/supressões.
- `webhook_events`: deduplicação e estado de webhooks sem payload de mensagem, telefone ou segredo.
- `audit_log`: auditoria administrativa.

## Coordenação distribuída e permissões

As RPCs `claim_follow_up`, `complete_follow_up` e `release_follow_up_claim` reivindicam, confirmam ou liberam a execução de follow-up. A reserva/liquidação de orçamento usa `reserve_ai_budget`, `settle_ai_budget`, `settle_ai_budget_effective` e `release_ai_budget`, conforme a versão da migration instalada.

Essas funções são `SECURITY DEFINER`, fixam `search_path` e têm execução revogada para `PUBLIC`, `anon` e `authenticated`; somente `service_role` pode chamá-las. `ai_budget_reservations` tem RLS habilitado e nenhuma política de acesso direto. A chave `service_role` deve ficar somente no ambiente do processo Node, nunca no navegador.

## Estado atual do código

O runtime persiste as áreas operacionais no Supabase e mantém arquivos locais como fallback:

```text
sessions.json              -> conversations + conversation_messages + contacts + pets
bot-config.json             -> bot_config_state + bot_config_revisions
memória de métricas         -> ai_calls e agregações
archive/*.json              -> conversations.status = 'archived'\ncopilot-tasks.json           -> fallback local da fila (somente uma réplica)
```

Na primeira inicialização com as variáveis de runtime configuradas, dados locais são importados quando ainda não existem no banco. Não remova os arquivos locais antes de validar a operação e o rollback.

### Retenção e expurgo

Por padrão, sessões ativas e registros arquivados são retidos por 30 dias (`SESSION_TTL_DAYS`, padrão 30). Arquivos `archive/*.json` com `archivedAt` anterior ao prazo são removidos pelo ciclo de manutenção. No Supabase, conversas com `status = 'archived'` e `archived_at` vencido são excluídas; a exclusão em cascata das mensagens segue a FK já definida na migração operacional. O expurgo remoto é limitado a uma execução a cada seis horas enquanto o processo está ativo e também ocorre na inicialização.

Conversas com estado `closed` nunca são removidas por essa política. Para preservar um arquivo ou conversa arquivada, marque `legalHold: true` ou `legal_hold: true` na sessão/`metadata` antes do prazo. O runtime usa apenas a coluna `metadata` já existente, sem exigir migração adicional. Arquivos inválidos, sem `archivedAt` verificável, ou linhas com marcação de retenção são mantidos.

Limites: o runtime só reconhece legal holds representados por esses marcadores; holds mantidos fora do arquivo/metadata não são detectáveis. Se o schema remoto não tiver sido migrado ou uma operação de expurgo falhar, os registros remotos são preservados e o erro fica disponível em `persistenceError`/logs. Backups externos e políticas de retenção do provedor Supabase não são afetados por esse expurgo.

## Aplicação pelo Supabase Dashboard

1. Crie um projeto Supabase exclusivo para o bot.
2. Abra **SQL Editor**.
3. Execute as migrations pendentes na ordem da seção anterior; verifique previamente o histórico do banco.
4. Opcionalmente, execute `seed.sql` em desenvolvimento/teste.
5. Em **Authentication > Users**, crie um usuário autorizado.
6. Copie o UUID desse usuário e execute:

```sql
insert into public.profiles (id, full_name, role, active)
values ('UUID_DO_USUARIO_AUTH', 'Administrador de Testes', 'admin', true)
on conflict (id) do update
set full_name = excluded.full_name,
    role = excluded.role,
    active = true;
```

## Aplicação com Supabase CLI

Com o projeto vinculado e as migrations revisadas:

```bash
supabase link --project-ref SEU_PROJECT_REF
supabase db push
```

Para um ambiente local descartável:

```bash
supabase db reset
```

O `db reset` reaplica as migrations locais. O seed pode ser executado separadamente no SQL Editor ou incorporado ao fluxo local conforme a configuração da CLI.

## Variáveis do bot

No `.env` do bot:

```env
SUPABASE_URL=https://SEU_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=SUA_CHAVE_PUBLISHABLE_OU_ANON
SUPABASE_SERVICE_ROLE_KEY=SUA_CHAVE_SERVICE_ROLE_DO_SERVIDOR
SUPABASE_RUNTIME_ENABLED=true
ALLOW_UNAUTHENTICATED_DASHBOARD=false
DASHBOARD_ALLOWED_ROLES=admin,operator
```

A `SUPABASE_URL` deve conter somente a origem do projeto. Não acrescente `/auth/v1` ou `/rest/v1`.

Nunca coloque `service_role` no navegador ou no código público. A chave publishable/anon continua sendo usada pelo login e pelas leituras públicas; `service_role` é consumida exclusivamente pelo processo Node para escritas operacionais protegidas.

## RLS e permissões

- Conteúdo público de planos ativos, FAQ e preferências é somente leitura para `anon` e `authenticated`.
- `profiles` pode ser consultado pelo próprio usuário autenticado.
- Dados operacionais podem ser consultados somente por perfis ativos.
- Configuração, métricas e auditoria exigem perfil ativo com role compatível.
- Campanhas/supressões têm leitura controlada; chaves de idempotência, reservas de orçamento e ledger de webhook não expõem acesso direto ao browser.
- RPCs de coordenação e orçamento são chamadas pelo backend com `service_role`; não conceder permissões mais amplas.

## Dados que o código atual lê

```text
plans
  slug, name, pet_species, age_range,
  monthly_price_cents, annual_price_cents, active

workspace_settings
  aeo_faq

workspace_preferences
  service_regions, working_start, working_end

profiles
  active, role
```

## Operação segura em testes

- Mantenha os planos do seed inativos até substituir pelos valores aprovados.
- Não copie telefones, conversas ou dados reais para este projeto sem necessidade.
- Use usuários de teste no Supabase Auth.
- Ative apenas perfis que devem acessar o dashboard.
- Valide RLS com `anon` e usuário autenticado antes de conectar a Evolution API.
- Depois de trocar o projeto, limpe a sessão antiga do navegador:

```js
localStorage.removeItem('lia-sync-session');
location.reload();
```
