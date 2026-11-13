# Supabase independente do bot

Esta documentação acompanha o Lia Sync **2.2.0**. O desenho do runtime e das fachadas de integração está em [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

Este diretório contém o banco de desenvolvimento/staging da Lia Sync. Ele é independente do Supabase do CRM original.

## Migrações

Execute nesta ordem:

1. `migrations/20261015222000_initial_bot_schema.sql`
2. `migrations/20261015223000_operational_bot_schema.sql`
3. `migrations/20261016000000_faq_table.sql` — compatibilidade para bancos que já executaram as migrations anteriores
4. `seed.sql` — carga inicial do conteúdo público inicial
5. `migrations/20261112210000_campaigns_bridge.sql` — campanhas, idempotência e estados da ponte
6. `migrations/20261112220000_phone_suppressions.sql` — supressões/opt-out canônicos, RLS e status de destinatário

A primeira migração cria a camada de integração atual. A segunda contém o domínio operacional usado pelo runtime híbrido: o Supabase é a fonte primária quando a `service_role` está configurada, com dual-write e fallback para `sessions.json` e `bot-config.json`.

## Estrutura completa

### Integração atual

- `profiles`: autorização do dashboard, ligada a `auth.users`.
- `plans`: planos comerciais lidos pelo bot, com valores em centavos de BRL.
- `faq`: perguntas e respostas canônicas, com `active`, ordenação e palavras-chave.
- `workspace_settings`: FAQ legado em `aeo_faq`, mantido para compatibilidade.
- `workspace_preferences`: regiões, horário e fuso usados pela FAQ dinâmica.

### Operação do atendimento

- `contacts`: contatos do WhatsApp, separados dos usuários administrativos.
- `pets`: pets identificados durante a coleta.
- `conversations`: estado da sessão, modo bot/humano, triagem, handoff e inatividade.
- `conversation_messages`: histórico normalizado de mensagens e deduplicação por ID externo.
- `handoffs`: fila de transferências, urgência, notificações, lembretes e resolução.
- `conversation_events`: auditoria de eventos de webhook, bot, humano e dashboard.

### Governança e observabilidade

- `bot_config_state`: configuração ativa, rascunho e revisão atual.
- `bot_config_revisions`: histórico de publicação e rollback.
- `ai_calls`: telemetria persistente sem prompts, respostas ou telefones completos.
- `audit_log`: auditoria administrativa.

## Estado atual do código

O runtime atual persiste essas áreas no Supabase e mantém os arquivos como fallback:

```text
sessions.json              -> conversations + conversation_messages + contacts + pets
bot-config.json            -> bot_config_state + bot_config_revisions
memória de métricas        -> ai_calls e agregações
archive/*.json             -> conversations.status = 'archived'
```

Na primeira inicialização com as variáveis de runtime configuradas, dados locais são importados quando ainda não existem no banco. Não remova os arquivos locais antes de validar a operação e o rollback.

### Retenção e expurgo

Por padrão, sessões ativas e registros arquivados são retidos por 30 dias (`SESSION_TTL_DAYS`, padrão 30). Arquivos `archive/*.json` com `archivedAt` anterior ao prazo são removidos pelo ciclo de manutenção. No Supabase, conversas com `status = 'archived'` e `archived_at` vencido são excluídas; a exclusão em cascata das mensagens segue a FK já definida na migração operacional. O expurgo remoto é limitado a uma execução a cada seis horas enquanto o processo está ativo e também ocorre na inicialização.

Conversas com estado `closed` nunca são removidas por essa política. Para preservar um arquivo ou conversa arquivada, marque `legalHold: true` ou `legal_hold: true` na sessão/`metadata` antes do prazo. O runtime usa apenas a coluna `metadata` já existente, sem exigir migração adicional. Arquivos inválidos, sem `archivedAt` verificável, ou linhas com marcação de retenção são mantidos.

Limites: o runtime só consegue reconhecer legal holds representados por esses marcadores; holds mantidos fora do arquivo/metadata não são detectáveis. Se o schema remoto não tiver sido migrado ou uma operação de expurgo falhar, os registros remotos são preservados e o erro fica disponível em `persistenceError`/logs. O prazo pode ser alterado via `SESSION_TTL_DAYS`; backups externos e políticas de retenção do provedor Supabase não são afetados por esse expurgo.

## Aplicação pelo Supabase Dashboard

1. Crie um projeto Supabase novo, exclusivo para o bot.
2. Abra **SQL Editor**.
3. Execute as duas migrações na ordem indicada.
4. Opcionalmente, execute `seed.sql` para dados de teste.
5. Em **Authentication > Users**, crie um usuário de teste.
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

Com o projeto vinculado:

```bash
supabase link --project-ref SEU_PROJECT_REF
supabase db push
```

Para um ambiente local descartável:

```bash
supabase db reset
```

O `db reset` reaplica as migrações locais. O seed pode ser executado separadamente no SQL Editor ou incorporado ao fluxo local conforme a configuração da CLI.

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

Nunca coloque `service_role` no navegador ou no código público. A chave publishable/anon continua sendo usada pelo login e pelas leituras públicas; a `service_role` é consumida exclusivamente pelo processo Node para escritas operacionais protegidas.

## RLS e permissões

- Conteúdo público de planos ativos, FAQ e preferências é somente leitura para `anon` e `authenticated`.
- `profiles` pode ser consultado pelo próprio usuário autenticado.
- Dados operacionais podem ser consultados somente por perfis ativos.
- Configuração, métricas e auditoria exigem perfil ativo com role compatível.
- Não há escrita direta exposta pelo dashboard nas tabelas operacionais.
- Escritas futuras devem usar RPCs controladas ou backend com `service_role` fora do navegador.

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
- Valide RLS com anon e com usuário autenticado antes de conectar a Evolution API.
- Depois de trocar o projeto, limpe a sessão antiga do navegador:

```js
localStorage.removeItem('lia-sync-session');
location.reload();
```
