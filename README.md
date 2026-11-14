# Lia Sync - Central de Atendimento Inteligente via WhatsApp

Bot Node 22 ESM de alta performance, sem dependências npm externas pesadas, integrado à Evolution API v2, Supabase CRM e ao Chatwoot Lia.

**Versão atual: 2.4.0** (pacote, metadata e documentação sincronizados).

## Novidades da Versão 2.4.0 — Roteamento por Capacidades, Tool Calling Estruturado, Voz WAV e Visão Multimodal

- **Roteador de modelos orientado a capacidades (`src/model-router.mjs`):** detecta explicitamente `fast_chat`, `tools`, `web_search`, `document_context` e `deep_reasoning`, ajustando `thinkingBudget` dinamicamente e impedindo que comandos curtos com ferramentas ou busca web caiam no tier `lite`. Consulte [`docs/release-2.4.0.md`](docs/release-2.4.0.md).
- **Tool Calling estruturado de passo único (`src/ai/call.mjs` e `src/ai/parsing.mjs`):** schema `tool_calls[].args` integralmente tipado e compatível com Gemini `v1beta` Structured Outputs, mais fallback multi-modelo e degradação graciosa de `tools` no OpenRouter/Qwen.
- **Leitura multimodal de PDFs e fotos com memória na sessão:** limite da ponte ampliado para 15 MB, análise via `gemini-2.5-flash` para anexos do painel e do WhatsApp e preservação de `lastAnalyzedDocument` para perguntas de acompanhamento.
- **Voz TTS com cabeçalho RIFF/WAV (`src/ai/voice.mjs`):** empacotamento automático de `audio/L16` PCM 24 kHz em container WAV válido para reprodução no WhatsApp/Evolution API e no painel.
- **Google Calendar OAuth2/Service Account e `/freeBusy`:** renovação automática de token em memória, endpoint `/freeBusy` corrigido e parser de datas (`hoje`, `amanhã`, `DD/MM/YYYY`, `YYYY-MM-DD`) ancorado em `America/Sao_Paulo`.
- **Projeção de setores isolada no banco:** nova migration `20261114072000_runtime_projections.sql` separa `sectors_projection` de `bot_config_state`.

## Novidades da Versão 2.3.1 — expediente central e setores no seu dono natural

- **Janela de atendimento no painel:** ativação, dias, início, fim, fuso, retomada automática e aviso de fora do expediente são administrados aqui, com rascunho, validação e publicação versionada. Consulte [`docs/release-2.3.1.md`](docs/release-2.3.1.md).
- **Validação fail-closed:** horas em `HH:MM`, fim depois do início, fuso IANA real, dias válidos e sem repetição, aviso de até 2000 caracteres. O motor continua fail-open em tempo de execução.
- **Chatwoot lê, não escreve:** a ponte `GET /api/bridge/v1/config` projeta o expediente já derivado (`isOpenNow`, `nextOpenAt`, `summary`) em campo aditivo do contrato v1; o texto do aviso ao cliente não é exposto. Detalhes em [`docs/config-bridge-contract.md`](docs/config-bridge-contract.md).
- **Setores continuam do Chatwoot:** `PUT/GET /api/bridge/v1/sectors` mantém uma projeção de runtime (máximo 100, apenas `id`, `name`, `description`, `isActive`) sem tocar em rascunho, revisão ou histórico.
- **Nenhum fluxo externo publica configuração:** publicar deixou de ser um efeito colateral de salvar setores no Chatwoot.

## Novidades da Versão 2.3.0 — confiabilidade e operação de IA

- O dashboard consulta catálogos de modelos pelo backend e permite publicar um modelo principal e até três modelos de fallback, sem enviar credenciais ao navegador.
- Limites mensais por provedor/modelo usam reserva distribuída e contabilizam o modelo efetivamente usado; custo/uso desconhecido não é tratado como zero.
- Follow-ups usam claim atômica no Supabase e falham fechados se a coordenação não puder ser confirmada.
- Webhooks sem ID estável recebem chave derivada sanitizada; o envio de áudio não é repetido automaticamente quando a entrega fica ambígua.
- O item 4 — expansão de busca semântica/conhecimento — permanece adiado e fora deste release.

## Novidades da Versão 2.2.2 — Widget Turnstile compartilhado

- O painel Lia Sync usa o widget Cloudflare Turnstile existente com a site key pública configurada por `SUPABASE_CAPTCHA_SITE_KEY`.
- O mesmo widget pode autorizar `liasync.atualyze.com.br` e `chat.atualyze.com.br`; o secret permanece exclusivamente no Supabase em **Authentication > Bot and Abuse Protection**.
- O painel envia o token CAPTCHA ao Supabase no login, sem armazenar secrets no frontend, no repositório ou nos logs.

## Novidades da Versão 2.2.1 — Consulta web resiliente

- **Recuperação de consulta:** quando o modelo aciona `consultar_web` sem preencher `query`, o motor usa a mensagem original do usuário como consulta, evitando `INVALID_QUERY` para pedidos válidos.
- **Contexto consistente:** tanto o atendimento ao cliente quanto o copiloto do responsável fornecem a mensagem original ao executor de ferramentas.
- **Regressão automatizada:** incluído teste para garantir a recuperação segura de consultas omitidas.

## Novidades da Versão 2.2.0 — Operação Centralizada

- **Painel Saúde & Operação:** visão autenticada de readiness, dependências, provedores, modelos, circuit breakers, tokens e incidentes.
- **Controle central no motor:** configurações, ferramentas, campanhas e supressões continuam no `lia-sync`; o Chatwoot Lia apenas consome a ponte autenticada.
- **Operação segura:** custos são identificados como estimativas quando não existe tabela de preços confiável, telefones de supressão são mascarados e o teste de integração não envia WhatsApp por padrão.
- **Persistência e contratos:** campanhas e opt-out usam as migrações canônicas do Supabase, com idempotência, RLS e contratos verificáveis.
- **Readiness reproduzível:** healthcheck, readiness, CI e documentação de deploy/rollback foram alinhados para publicação controlada.

## Base consolidada da Versão 2.1.0

- **Arquitetura modular:** IA, HTTP, fluxo de atendimento e identidade foram separados em módulos coesos, mantendo `ai.mjs`, `flow.mjs` e `server.mjs` como fachadas compatíveis.
- **Identidade publicada pelo painel:** nome da assistente, responsável, empresa, apelidos, tom e telefone humano não são definidos no código operacional.
- **Mídias confiáveis:** PDFs gerados pelo Copiloto são enviados como documento no WhatsApp; respostas em áudio não recebem legenda duplicada.
- **Build portátil:** `npm run build` e `npm run lint` usam Node nativo e funcionam no Windows, Linux e macOS.

Consulte [ARCHITECTURE.md](ARCHITECTURE.md) para os limites e responsabilidades de cada módulo.

## Arquitetura

As regras determinísticas — autenticação do webhook, dedupe/rate limit, grupos ignorados, sanitização, emergência, filtro clínico, fila por telefone, persistência e handoff — nunca dependem da IA. A IA atende saudação, planos, políticas, pagamento, dúvidas, coleta e triagem não emergencial; recebe JSON estrito e contexto, mas não decide regras de segurança.

O código é organizado em módulos pequenos, com fachadas finas para compatibilidade:

- `core/identity.mjs` e `core/messages.mjs` — identidade, apelidos, chaves internas e mensagens padrão (tudo vindo do painel, com fallback neutro);
- `flow/text.mjs`, `flow/owner.mjs`, `flow/client.mjs`, `flow/media.mjs`, `flow/pdf.mjs` — helpers de texto, copiloto do responsável, atendimento ao cliente, mídia/voz e PDFs;
- `ai/` — configuração de provedores, parsing, busca web, documentos, voz e orquestração de chamadas;
- `http/` — utilidades, bridge/SSE, proxy Chatwoot, dashboard, rotas de bridge, webhook e roteador;
- `config`, `knowledge`, `safety`, `sessions`, `handoff`, `whatsapp`, `faq`, `dashboard`, `admin-config` e o bootstrap `server`.

A identidade da assistente (nome, responsável, empresa, tom, apelidos e telefone) é configurada no painel e não é fixada em código.

## Painel administrativo

O dashboard é servido em `/dashboard` e agora possui uma área **Administração** para controlar o contexto publicado do bot sem editar código.

É possível editar:

- identidade da assistente, responsável, empresa, apelidos e tom de voz;
- área de atendimento, fuso horário e tom de voz;
- limite de turnos clínicos e retomada pelo cliente;
- mensagens de fallback, saudação, planos, serviços, políticas e pagamento;
- provedor e modelo de IA ativos, modelos de fallback e parâmetros de saída;
- telefone e habilitação do atendimento humano;
- itens da base de conhecimento, palavras-chave e status ativo/inativo.

As alterações são gravadas como **rascunho** e só passam a valer após **Publicar alterações**. Cada publicação gera uma revisão. O sistema mantém histórico e suporta rollback de versões publicadas.

### Preview antes de publicar

A área administrativa possui um preview isolado. Ele executa uma mensagem usando o rascunho atual, sem publicar e sem afetar a operação real:

- não altera sessões reais;
- não envia mensagem pelo WhatsApp;
- não dispara handoff ou notificação para a equipe;
- não aparece na caixa de entrada real;
- remove a sessão temporária ao final.

Endpoint protegido:

```text
POST /api/admin/config/preview
```

Payload:

```json
{"phone":"5586999962542","text":"Oi, quero conhecer os planos."}
```

### APIs administrativas

```text
GET    /api/admin/config
PATCH  /api/admin/config/draft
POST   /api/admin/config/validate
POST   /api/admin/config/preview
POST   /api/admin/config/publish
POST   /api/admin/config/rollback
```

A configuração é persistida no Supabase em `bot_config_state` e `bot_config_revisions`. O backend mantém `data/bot-config.json` como cópia de fallback/rollback local; ele não é usado como fonte primária quando o runtime Supabase está ativo.

## Segurança e dados

Toda resposta passa por `filterReply`. Preços só são aceitos quando vieram literalmente dos planos ativos do CRM. Sessões reais usam `<telefone>` e simulações `sim:<telefone>`. Para um JID `@lid`, o bot usa um número alternativo apenas quando a Evolution o fornece; caso contrário, preserva o JID completo para envio, sem inventar número. Conversas e mensagens vão para `contacts`, `conversations` e `conversation_messages`; `ai_calls` recebe telemetria sem prompts, respostas ou telefones. O backend mantém dual-write local por segurança e cai automaticamente para os JSON se o Supabase ficar indisponível. Para ativar, configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` e `SUPABASE_SERVICE_ROLE_KEY`, mantendo a última chave somente no ambiente do servidor. `SUPABASE_RUNTIME_ENABLED=false` desliga a migração sem remover o fallback. O arquivo de sessões é retido por 30 dias por padrão e grava atomicamente. Para o volume Docker, use `chown 1000:1000 data`.

As proteções de segurança configuradas para a operação permanecem no código: o painel pode controlar contexto e comportamento operacional, mas não remove os limites de resposta e encaminhamento definidos pelo produto.

## Configuração e execução

```bash
cp .env.example .env
# preencha credenciais somente no .env
npm test
npm run build
npm start
```

`EVOLUTION_INSTANCE` não tem default implícito e deve ser o nome da instância no Evolution API (ex.: `lia-sync`). Sem `WEBHOOK_TOKEN`, o servidor não sobe, exceto com `ALLOW_INSECURE_WEBHOOK=true` em desenvolvimento.

Para iniciar o servidor localmente sem `WEBHOOK_TOKEN`, use somente em desenvolvimento e vincule-o ao loopback. O painel continua exigindo autenticação do Supabase; `ALLOW_UNAUTHENTICATED_DASHBOARD` não habilita acesso anônimo:

```bash
PORT=3000 \
HOST=127.0.0.1 \
EVOLUTION_INSTANCE=lia-sync \
ALLOW_INSECURE_WEBHOOK=true \
npm start
```

Depois acesse `http://127.0.0.1:3000/dashboard`.

## Login e proteção CAPTCHA do Supabase

Se o projeto tiver **CAPTCHA Protection** habilitado em `Authentication > Bot and Abuse Protection`, o login de senha precisa enviar um token CAPTCHA. O dashboard suporta **Cloudflare Turnstile** por padrão e hCaptcha como alternativa:

```env
SUPABASE_CAPTCHA_PROVIDER=turnstile
SUPABASE_CAPTCHA_SITE_KEY=CHAVE_PUBLICA_DO_WIDGET
```

A chave deve ser a **site key pública** do mesmo provedor configurado no Supabase. O dashboard carrega o widget, envia `captcha_token` ao endpoint de autenticação e renova o token quando ele expira. Para hCaptcha, use `SUPABASE_CAPTCHA_PROVIDER=hcaptcha`.

Se a proteção estiver ativada sem `SUPABASE_CAPTCHA_SITE_KEY`, o Supabase retornará `captcha protection: request disallowed (no captcha_token found)`. Nesse caso, configure o widget ou desative a proteção CAPTCHA em `Authentication > Bot and Abuse Protection`.

## Supabase independente do bot

O repositório inclui migrações para um projeto Supabase próprio, separado do CRM original. A estrutura cobre autenticação, perfis, planos, FAQ, preferências, contatos, pets, conversas, mensagens, handoffs, eventos, configuração versionada, métricas de IA e auditoria.

Para um projeto novo, execute no SQL Editor as migrações pendentes nesta ordem; confirme o histórico do banco antes de reaplicar. `seed.sql` é opcional e destinado a testes:

```text
supabase/migrations/20261015222000_initial_bot_schema.sql
supabase/migrations/20261015223000_operational_bot_schema.sql
supabase/migrations/20261016000000_faq_table.sql
supabase/migrations/20261112210000_campaigns_bridge.sql
supabase/migrations/20261112220000_phone_suppressions.sql
supabase/migrations/20261113000000_operations_observability.sql
supabase/migrations/20261113152048_follow_up_atomic_claim.sql
supabase/migrations/20261113153840_atomic_ai_budgets.sql
supabase/migrations/20261113154223_ai_budget_effective_model.sql
supabase/migrations/20261114072000_runtime_projections.sql
supabase/seed.sql  # opcional, somente desenvolvimento/teste
```

As três migrations de follow-up/orçamento foram aplicadas e verificadas no Supabase conectado durante a release 2.3.0. Consulte [`supabase/README.md`](supabase/README.md) para detalhes de cada etapa, RLS, RPCs e configuração do usuário administrador. Na primeira inicialização com o runtime configurado, sessões e configuração locais existentes são importadas quando ainda não existem no banco; as APIs do painel informam `persistence: supabase` ou `fallback`.

## Provedores de IA e diagnóstico de conexão

Os testes de latência do dashboard só são executados para provedores com credencial configurada. Modelos gratuitos do OpenRouter também exigem `OPENROUTER_API_KEY`.

Configuração publicada no dashboard: `ai.activeProvider`, `ai.activeModel` e `ai.fallbackModels` definem a seleção da IA; `human.phone` e `human.enabled` definem o atendimento humano. No modelo Supabase, esses campos correspondem a `bot_config_state.active_config.ai` e `bot_config_state.active_config.human`. As chaves continuam exclusivamente no `.env`.


Se um provedor não estiver configurado, o painel informa isso diretamente em vez de exibir uma falha genérica de resposta vazia.

## Contrato JSON da IA

`{ reply, intent, red_flags, handoff, handoff_reason, collected }`. O parser aceita cercas, objeto balanceado e texto cru. O histórico armazena apenas a resposta filtrada.

## Teste com curl

```bash
curl http://127.0.0.1:3000/health
curl -X POST 'http://127.0.0.1:3000/api/dashboard/simulate?x=1' \
  -H 'Authorization: Bearer TOKEN' -H 'Content-Type: application/json' \
  -d '{"phone":"5586999962542","text":"Oi"}'
```

## Deploy e rollback do webhook

Antes do deploy, execute `npm ci`, `npm run lint`, `npm run build`, `npm test`, `npm run test:contract` e `git diff --check`. Salve a configuração atual da instância Evolution e a referência da imagem anterior. Atualize com `docker compose up -d --build bot`, confirme o container com `docker compose ps bot` e valide `curl --fail http://127.0.0.1:3000/health` e `/ready`. Só então valide um payload de teste sem envio a clientes e configure o webhook para `/webhook/evolution`, evento `MESSAGES_UPSERT` e header `Authorization: Bearer <WEBHOOK_TOKEN>`. Para rollback, restaure a imagem/configuração anterior, valide health/readiness e mantenha os volumes de dados.

## Limites operacionais

Confirme os textos comerciais, a política de preços exclusivamente via CRM e o telefone humano na configuração publicada. A semântica exata de `source` da Evolution, `fromMe` e JIDs `@lid` varia por versão/instância e precisa de payload real. Os lembretes de handoff e a manutenção de inatividade são executados pelo timer do servidor; em múltiplas réplicas, deve existir apenas um worker ativo ou um lock distribuído.

A versão atual também coalesce mensagens do webhook dentro de `MESSAGE_DEBOUNCE_MS`, limita o custo por janela, pausa automaticamente quando a Dra. responde pelo celular e executa manutenção de lembretes/inatividade. O dashboard atualiza a cada 5 segundos enquanto a aba está visível e arquiva conversas reais em vez de apagá-las.

### Retomada do bot após atendimento humano

Quando uma sessão está em atendimento humano, o cliente pode enviar `bot`, `voltar` ou `reativar`; o fluxo grava a retomada no store ativo, com `conversations` como fonte primária e `sessions.json` como fallback. Essa opção fica ativa por padrão (`HUMAN_ALLOW_CLIENT_RESUME=true`) e pode ser desligada explicitamente com `false`. O responsável também pode enviar `bot <telefone>` a partir do número publicado em `bot_config_state.active_config.human.phone`; esse comando é processado antes da lógica de `fromMe`, evitando que seja confundido com uma nova tomada de controle humano.
