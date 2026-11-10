# Lia Sync - Central de Atendimento Inteligente via WhatsApp

Bot Node 22 ESM de alta performance, sem dependências npm externas pesadas, integrado à Evolution API v2, Supabase CRM e ao Chatwoot Lia.

**Versão atual: 2.1.0**

## Novidades da Versão 2.1.0

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

Para testar o painel localmente sem Supabase, use somente em desenvolvimento:

```bash
PORT=3000 \
HOST=0.0.0.0 \
EVOLUTION_INSTANCE=lia-sync \
ALLOW_INSECURE_WEBHOOK=true \
ALLOW_UNAUTHENTICATED_DASHBOARD=true \
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

Execute no SQL Editor, nesta ordem:

```text
supabase/migrations/20261015222000_initial_bot_schema.sql
supabase/migrations/20261015223000_operational_bot_schema.sql
supabase/seed.sql  # opcional para testes
```

Consulte [`supabase/README.md`](supabase/README.md) para configurar o usuário administrador, RLS e as variáveis. Na primeira inicialização com o runtime configurado, sessões e configuração locais existentes são importadas quando ainda não existem no banco; as APIs do painel informam `persistence: supabase` ou `fallback`.

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

Salve a configuração atual da instância Evolution e confirme `curl http://127.0.0.1:3000/health`. Execute `docker compose up -d --build`, confirme o healthcheck e valide um payload de teste. Só então configure o webhook para `/webhook/evolution`, evento `MESSAGES_UPSERT` e header `Authorization: Bearer <WEBHOOK_TOKEN>`. Para rollback, restaure a configuração salva, valide o health da Evolution e mantenha o container anterior disponível até a confirmação.

## Limites operacionais

Confirme os textos comerciais, a política de preços exclusivamente via CRM e o telefone humano na configuração publicada. A semântica exata de `source` da Evolution, `fromMe` e JIDs `@lid` varia por versão/instância e precisa de payload real. Os lembretes de handoff e a manutenção de inatividade são executados pelo timer do servidor; em múltiplas réplicas, deve existir apenas um worker ativo ou um lock distribuído.

A versão atual também coalesce mensagens do webhook dentro de `MESSAGE_DEBOUNCE_MS`, limita o custo por janela, pausa automaticamente quando a Dra. responde pelo celular e executa manutenção de lembretes/inatividade. O dashboard atualiza a cada 5 segundos enquanto a aba está visível e arquiva conversas reais em vez de apagá-las.

### Retomada do bot após atendimento humano

Quando uma sessão está em atendimento humano, o cliente pode enviar `bot`, `voltar` ou `reativar`; o fluxo grava a retomada no store ativo, com `conversations` como fonte primária e `sessions.json` como fallback. Essa opção fica ativa por padrão (`HUMAN_ALLOW_CLIENT_RESUME=true`) e pode ser desligada explicitamente com `false`. O responsável também pode enviar `bot <telefone>` a partir do número publicado em `bot_config_state.active_config.human.phone`; esse comando é processado antes da lógica de `fromMe`, evitando que seja confundido com uma nova tomada de controle humano.
