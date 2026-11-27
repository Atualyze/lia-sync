# Lia Sync - Central de Atendimento Inteligente via WhatsApp

Bot Node 22 ESM de alta performance com motor **WhatsApp Nativo via Baileys** (WebSocket direto, baixo consumo de RAM) e suporte opcional à Evolution API v2, integrado ao Supabase CRM e ao Chatwoot Lia.

**Versão atual: 3.5.0** (pacote, painel, metadata, Runtime, autoconhecimento e documentação sincronizados).

## Novidades da Versão 3.5.0 — CRM Inteligente na Lia, Suporte Dedicado por Contato, Inbox CRM-First & Mobile

- **CRM & Histórico Completo na Lia (`src/tools/`, `src/flow/`, `src/knowledge.mjs`):** `consultar_contato_ou_lead` agora resolve contatos por telefone, `external_id` ou nome e retorna ficha CRM completa (`aiContext`, etapa, setor, tags, notas e histórico completo da conversa quando solicitado), além de resumo de contatos CRM no prompt do Copiloto e suporte a respostas citadas (`replyTo`) no Baileys, simulador e chat interno.
- **Flag "Não é lead" (`notALead`):** oculta o contato do Funil / Kanban, bloqueia follow-ups automáticos e orienta a Lia a tratá-lo sem abordagem comercial de funil.
- **Atendimento Próprio de Suporte (`.md` por contato):** vinculação de uma ou mais bases `.md` em `data/knowledge-bases/suporte_tecnico/` na Ficha do Lead (`supportMode` + `supportKnowledgeBases`), com upload direto no painel.
- **Inbox CRM-First, Sidebar & Mobile (`public/index.html`, `public/app.js`, `public/styles.css`):** filtro por etapa do funil, faixa CRM rápida no chat, dossiê lateral editável, menus *Assistente* e *Plataforma* recolhidos por padrão e layout responsivo otimizado para mobile.

Detalhes técnicos: [`docs/release-3.5.0.md`](docs/release-3.5.0.md).

## Novidades da Versão 3.4.0 — Canais Oficiais, CRM Kanban, Cadências, Reputação, Ligação Perdida, Setores & Multi-tenant

- **Canais Oficiais (`WHATSAPP_PROVIDER=manychat` / `ghl`):** além do Baileys Nativo, agora suporta **ManyChat** (`/webhook/manychat`) e **GoHighLevel** (`/webhook/ghl`) com API oficial, handoff por tags e atualização de oportunidades.
- **Funil / Kanban & Cadências:** nova aba **Funil / Kanban** em 5 etapas, réguas configuráveis de follow-up por tempo sem resposta e painel **Ligação Perdida** (`/webhook/missed-call`).
- **Pós-atendimento & Reputação:** pesquisa automática 1–5 ao concluir atendimentos com direcionamento de notas altas ao **Google Meu Negócio**.
- **Setores & Multi-tenant:** menu **Setores** com 10 setores configuráveis ligados ao `triage-router` e suporte a subcontas (`/webhook/(manychat|ghl)/:tenantId`).

## Novidades da Versão 3.3.0 — Ciclo Operacional Autônomo, Revisão Humana & Idempotência

- **Revisão operacional diária (`src/autonomy/engine.mjs`, `src/server.mjs`):** cada instância do scheduler do Lia Runtime executa uma revisão por dia local depois do horário configurado em `owner_preferences.digestHour` (padrão: 9h), usando o fuso de atendimento. A revisão considera objetivos ativos, compromissos pendentes e saúde operacional; sem motivo real, não envia uma mensagem artificial.
- **Escalação ao administrador (`src/runtime/index.mjs`):** eventos que exigem intervenção humana geram um pedido de revisão com tipo e motivo, sem encaminhar o payload do evento. Compromissos mantêm a notificação específica existente; destinatários `owner:*` são roteados ao telefone do responsável.
- **Notificações idempotentes (`src/autonomy/store.mjs`):** a reserva persistente ocorre antes do envio. A chave única de `lia_proactive_notifications` evita duplicidade entre réplicas Supabase e sobrevive a reinicializações; o fallback local destina-se a instância única.
- **Limites preservados:** o ciclo desta versão não inclui CRM. Follow-ups externos continuam sujeitos às políticas e guardas já existentes; pagamentos, efeitos incertos, ações irreversíveis, mudanças de segurança e deploy continuam exigindo confirmação humana ou bloqueados.

Detalhes técnicos: [`docs/release-3.3.0.md`](docs/release-3.3.0.md), [`docs/lia-runtime.md`](docs/lia-runtime.md), [`docs/lia-autonomy.md`](docs/lia-autonomy.md) e [`docs/lia-safety.md`](docs/lia-safety.md).

## Novidades da Versão 3.2.0 — Google Workspace REST, Autonomia Recorrente, Memória PARA & Resiliência

- **Google Workspace REST Puro (`src/tools/google_http.mjs`, `src/tools/gerenciar_gmail_google.mjs`, `src/tools/gerenciar_agenda_google.mjs`, `src/tools/gerenciar_drive_google.mjs`):** cliente HTTP endurecido com allowlist de hosts/prefixos, bloqueio de redirects, retry seguro apenas em `GET` (nunca em escritas), nova ferramenta **Gmail** exclusiva do dono (busca, leitura MIME e rascunhos seguros sem envio automático), **Google Calendar `sugerir_horarios`** em múltiplos dias e **Google Docs `atualizar_documento`** (anexar/substituir).
- **Autonomia Completa & Rotinas Recorrentes (`src/runtime/schedule-parser.mjs`, `src/runtime/index.mjs`, `src/server.mjs`, `src/flow/owner.mjs`):** scheduler dedicado de **15 segundos** no `Lia Runtime`, agendamento em linguagem natural para tempo relativo, horário fixo (*"amanhã às 9h"*) e rotinas recorrentes (*"todo dia às 8h"*, *"toda segunda às 9h"*, *"a cada 2 horas"*) com auto-reagendamento, suporte a Saúde/Infra, Gmail, Agenda, Planilhas e Web, comandos naturais para listar/cancelar e bloqueio de promessas falsas (`"Agendado!"`).
- **Memória Estruturada PARA + Painel (`src/core/memory.mjs`, `src/http/runtime-routes.mjs`, `public/index.html`, `public/app.js`):** organização automática em **Projetos**, **Áreas**, **Recursos** e **Arquivo**, com card dedicado na aba **Lia Runtime** para filtrar, adicionar, editar e excluir memórias.
- **Resiliência de VPS, Reações no WhatsApp & Smart `Retry-After` (`src/ops/log-redaction.mjs`, `src/ops/event-loop-monitor.mjs`, `src/whatsapp/baileys-provider.mjs`, `src/ai/state.mjs`, `src/ai/call.mjs`, `src/safety.mjs`):** máscara automática de segredos em logs, monitor de stalls do Event Loop em `/ready` e `consultar_saude_infra`, guarda anti-links inventados, recuperação imediata de tarefas interrompidas no restart, reações de progresso no WhatsApp (`⏳` → `✅`/`⚠️`), conversão automática de tabelas Markdown em bullets limpos e controle de `reasoning_effort` + `Retry-After` para provedores de IA.

Detalhes técnicos: [`docs/release-3.2.0.md`](docs/release-3.2.0.md).

## Novidades da Versão 3.1.0 — WhatsApp Nativo (Baileys), Provedores Customizados e Continuidade entre Modelos

- **WhatsApp Nativo via Baileys (`src/whatsapp/baileys-provider.mjs`, `src/whatsapp/baileys-auth.mjs`):** transporte WebSocket embutido sem dependência obrigatória da Evolution API, com conexão por QR Code/Pairing Code no painel, `syncFullHistory: false`, **Message Gate** P0+P1 (deduplicação O(1), filtro de status/grupos/presença e mídia sob demanda), sessão compacta em arquivo único (`auth-snapshot.json`) com `BoundedLruCache` e backup automático no Supabase (`runtime_projections`), além de reconexão transparente em `515 (restartRequired)`.
- **Provedores de IA Customizados, Hot-Reload e Diagnóstico Real (`src/ai/custom-providers.mjs`, `src/ai/errors.mjs`, `src/api-settings.mjs`):** suporte a provedores OpenAI-compatible no painel, roteamento por prioridade, hot-reload de credenciais, particionamento de deadline entre provedores de contingência e diagnóstico explícito de falhas no Copiloto.
- **Continuidade Conversacional entre Modelos e Fallbacks (`src/knowledge.mjs`, `src/ai/parsing.mjs`, `src/safety.mjs`, `src/flow/owner.mjs`, `src/flow/client.mjs`):** bloco `[CONTINUIDADE_ENTRE_MODELOS_E_TURNOS]` para Copiloto e Cliente, preservação de histórico em trocas de tarefa/modelo, retenção de turnos da assistente em `normalizeHistory` e filtro `stripRedundantSelfIntroduction` que impede reapresentações de primeiro contato quando o modelo muda ou entra em fallback.
- **Painel Autonomia, Runtime & Baileys (`public/index.html`, `public/app.js`, `src/http/operations.mjs`):** novas abas de Autonomia/Runtime, gerenciamento visual de provedores customizados e exibição nativa do status do Baileys na aba Integrações e no Overview.

Detalhes técnicos: [`docs/release-3.1.0.md`](docs/release-3.1.0.md).

## Novidades da Versão 3.0.0 — Lia Runtime, Aprendizado Contínuo e Autonomia Operacional

- **Lia Runtime (`src/runtime/*`):** estado operacional persistente separado de sessões e histórico (`lia_identity`, `lia_goals`, `lia_events`, `lia_commitments`, `lia_runtime_state`), Attention Engine determinístico sem loops de LLM, recuperação automática após restart e wake-up via scheduler distribuído `maintenance`, reutilizando `copilot_tasks` como única fila de execução.
- **Learning Engine (`src/learning/*`):** Experience Store com deduplicação e TTL, Feedback Engine ponderado, Reflection Engine com fallback determinístico em `AI_PROVIDER_CREDITS_EXHAUSTED`, sistema de confiança com desaprendizado preservando histórico, isolamento de escopos (`individual`, `relationship`, `business`, `segment`, `global`), Strategy Registry versionado, Experiment Engine seguro com auto-rollback e fronteira explícita `ALLOW`/`DENY` (propostas de alteração de código viram `improvement_proposal`).
- **Autonomy Engine (`src/autonomy/*`):** Permission Engine em 4 categorias (`A` interna, `B` pré-autorizada por organização, `C` confirmação obrigatória e `D` proibida), `PresenceEngine`, `CommunicationGuard` com deduplicação/cooldown, `VerificationEngine` (diferencia tentativa de resultado confirmado), `SalesAutonomy`, `SupportAutonomy`, `RelationshipEngine`, CRM Ports desacoplados e trilha de auditoria completa.
- **Hardening estrutural e performance:** graceful shutdown seguro com `drainPending()`, ledger de webhooks fiel a lotes em debounce, broadcast SSE no worker do Copiloto com drenagem imediata (`drain()` + `onEnqueue`), limpeza de `Map`/`Set` com limites de memória e modularização de `src/flow/owner.mjs` (`owner-helpers.mjs` e `owner-commands.mjs`).
- **Migrations e Readiness:** aplicadas as migrations backend-only com RLS (`20261121100000_lia_runtime.sql`, `20261121120000_lia_learning.sql` e `20261121150000_lia_autonomy.sql`); `/ready` monitora `copilot_tasks`, `lia_runtime`, `lia_learning` e `lia_autonomy`.

Detalhes e guias: [`docs/release-3.0.0.md`](docs/release-3.0.0.md), [`docs/lia-runtime.md`](docs/lia-runtime.md), [`docs/lia-learning.md`](docs/lia-learning.md), [`docs/lia-autonomy.md`](docs/lia-autonomy.md) e [`docs/lia-safety.md`](docs/lia-safety.md).

## Novidades da Versão 2.9.0 — Execução persistente de tarefas do Copiloto

- **Fila durável:** solicitações de consulta e tarefas elegíveis são registradas no Supabase com chave idempotente, estados, etapas, checkpoints e leases.
- **Worker independente:** o servidor reivindica tarefas em segundo plano e entrega o resultado ao responsável mesmo depois de encerrada a requisição original.
- **Continuidade determinística:** respostas curtas como “Direto” são interpretadas no contexto da pergunta anterior; “estou esperando” consulta o estado real da tarefa.
- **Falhas visíveis:** tarefas concluídas, falhas e resultados incertos geram uma notificação de estado; nenhuma ação externa incerta é repetida automaticamente.
- **Segurança:** a fila é backend-only, limitada a quatro etapas, revalida disponibilidade das ferramentas e preserva políticas de confirmação e auditoria.

A migration `20261120150000_copilot_task_queue.sql` deve ser aplicada no Supabase antes do deploy. Se o Supabase estiver configurado mas a fila não existir, o runtime falha fechado; fallback local exige `COPILOT_TASK_LOCAL_FALLBACK=true` e uma única instância.

Detalhes: [`docs/release-2.9.0.md`](docs/release-2.9.0.md).

## Novidades da Versão 2.8.0 — Continuidade natural do Copiloto

- **Tarefas em andamento:** o Copiloto preserva o pedido original, a última pergunta, o tipo de tarefa e as ferramentas autorizadas ao longo de respostas curtas, reformulações, correções e mudanças parciais de assunto.
- **Revisão semântica de ferramentas:** antes de executar uma ferramenta que não esteja explicitamente ligada à mensagem atual, a Lia avalia se é continuação, novo pedido, pedido de esclarecimento ou assunto não relacionado.
- **Esclarecimentos seguros:** frases como “não entendi”, “pode explicar?” e “como assim?” não executam cobranças, envios ou outras ações; a Lia esclarece o próximo passo.
- **Áudio do responsável:** mensagens de áudio recebidas no chat interno são transcritas antes da interpretação. Se a transcrição falhar, a Lia pede reenvio ou resumo sem presumir o conteúdo.
- **Persistência:** o contexto de continuidade e a lista de ferramentas permitidas são persistidos no Supabase, com expiração de tarefas antigas e isolamento do modo Copiloto.
- **Validação:** a suíte atual contém 350 testes automatizados aprovados, além de lint, build, contratos e publicação da imagem Docker.

Detalhes técnicos e operação: [`docs/release-2.8.0.md`](docs/release-2.8.0.md).

## Novidades da Versão 2.7.0 — Atualyze Pay

- **Portal unificado:** `/pix` agora renderiza o portal responsivo `pay.atualyze.com.br`, com layout premium adaptável para desktop e mobile.
- **Ações claras:** o cliente pode escanear o QR Code, copiar a chave Pix, copiar o código Pix e Cola ou abrir o checkout InfinitePay em um botão dedicado.
- **Integração de fluxos:** Pix e InfinitePay retornam `paymentUrl` unificado quando há chave Pix configurada, mantendo o link oficial de checkout como fallback.
- **Segurança:** checkout exibido somente após validação de domínio, sem expor chaves de API no navegador; payload e QR Code são derivados da cobrança.

Detalhes técnicos e operação: [`docs/release-2.7.0.md`](docs/release-2.7.0.md).

## Novidades da Versão 2.6.1 — Agenda com retorno garantido e documentação operacional

- **Agenda no atendimento ao cliente:** quando habilitada, `gerenciar_agenda_google` pode consultar horários, listar compromissos e criar eventos a partir da conversa com o cliente.
- **Retorno explícito:** consultas de agenda e lembretes não deixam mais a Lia apenas prometendo verificar algo; sucesso, ausência de horários, integração desativada e falha são convertidos em uma resposta clara.
- **Encaminhamento seguro:** falhas reais de agenda ou persistência de retorno acionam `triggerHandoff` e nunca confirmam um horário ou lembrete que não tenha sido persistido.
- **Deploy documentado:** a aplicação usa `/home/ubuntu/lia-assistente`, o serviço Compose é `bot` e o contêiner é `lia-bot`; o volume `data/` deve ser gravável pelo usuário `node` (`UID:GID 1000:1000`).
- **Validação:** regressões específicas cobrem permissões de agenda para clientes, retorno de horários e comportamento de erro.

Detalhes técnicos e procedimento de deploy: [`docs/release-2.6.1.md`](docs/release-2.6.1.md).

## Novidades da Versão 2.6.0 - Conhecimento contextual e conversa natural

- **Conhecimento como repertório de raciocínio:** bases vinculadas agora entregam somente os trechos relevantes ao assunto atual, sem despejar manuais inteiros na conversa.
- **Contexto estruturado:** a Lia preserva objetivo, necessidade, próximo passo e informações confirmadas para interpretar referências curtas e conduzir o atendimento sem repetir perguntas.
- **Segurança entre clientes:** clientes sem base vinculada não recebem dossiês de outros clientes por coincidência lexical; alteração direta de CRM fica restrita ao Copiloto.
- **Formatação adaptativa:** WhatsApp e chat interno continuam usando negrito, bullets e parágrafos quando ajudam a leitura, sem transformar toda resposta em um template. A saída remove travessões longos.
- **Validação:** 302 testes automatizados, incluindo regressões de contexto, isolamento de bases, ferramentas e formatação.

## Novidades da Versão 2.5.1 — Hardening de prospecção e privacidade

- RLS service-role-only nas tabelas `prospect_*`, com schema consolidado regenerado.
- Opt-out contextual, confirmação não bloqueada, retries com backoff, claims órfãos recuperáveis e pausa anti-ban entre envios.
- Scheduler protegido contra sobreposição, contagem diária no fuso local, fila sem head-of-line blocking e cadências por etapas.
- 296 testes automatizados, 26 contratos de arquitetura e 142 módulos verificados.

**Operação na VPS:** o projeto fica em `/home/ubuntu/lia-assistente` e é executado pelo serviço Docker Compose `bot`, que cria o contêiner `lia-bot`. A pasta é o diretório ativo da aplicação, não um segundo bot. Repositório espelho: `/home/ubuntu/lia-sync-repo`. O volume `data/` é persistente e deve manter propriedade `1000:1000` para o usuário `node` do contêiner.

## Novidades da Versão 2.5.0 — API Pública v1, Integrações no Painel, Bases Inteligentes e White-Label 100%

- **API Pública `/api/v1/*` e Chaves/Webhooks no Painel:** geração de Chaves de API (`lia_live_...` com escopos `read`, `write`, `ai`), Webhooks de Saída com assinatura HMAC-SHA256 (`x-lia-signature`) e proteção SSRF, além de guia n8n integrado na aba **Integrações**. Consulte [`docs/release-2.5.0.md`](docs/release-2.5.0.md).
- **Bases de Conhecimento com Busca por Conteúdo:** leitura recursiva de subpastas (`autoconhecimento/`, `suporte_tecnico/`, `sales_intelligence/`, `biblioteca_juridica/`), ignorando `README.md`, com pontuação por seções `##` e injeção enxuta de diretrizes e suporte.
- **Reativação Inteligente e Síntese do Copiloto:** detecção automática de cliente sem resposta (*no vácuo*) ao reativar a IA, resolução automática pela resposta do responsável no chat interno e síntese genérica `[TOOL_RESULTS_JSON]` para todas as ferramentas do Copiloto.
- **Presença WhatsApp e Rascunho:** indicador antecipado de `composing`/`recording` enquanto a IA processa e botão **Cancelar** na barra flutuante (`POST /api/admin/config/discard`).
- **White-Label 100%:** remoção completa de referências pessoais fixas, chave interna neutra `owner_self` e identidade dinâmica em todo o motor e painel.

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
- O mesmo widget pode autorizar `crm.atualyze.com.br` e `crm.atualyze.com.br`; o secret permanece exclusivamente no Supabase em **Authentication > Bot and Abuse Protection**.
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

## Automanutenção da Lia

A Lia possui ferramentas internas protegidas para manutenção do próprio sistema:

- `gerenciar_configuracao`: consulta a configuração e altera primeiro o rascunho; publicação exige confirmação explícita.
- `gerenciar_codigo`: lê arquivos permitidos e pode criar um Pull Request de correção em branch separada; não faz merge nem deploy.
- Segredos, tokens, senhas, `.env`, `package.json`, arquivos de dados e outros caminhos sensíveis são bloqueados.
- O fluxo de código depende de `GITHUB_TOKEN` disponível somente no runtime do bot. O token deve ter permissão de escrita no conteúdo do repositório; alterações em workflows também exigem permissão de Workflows. O endpoint de conteúdo do GitHub exige permissões de escrita adequadas. (consulte a documentação oficial do GitHub sobre [Contents API](https://docs.github.com/en/rest/repos/contents) e [Git Trees](https://docs.github.com/en/rest/git/trees))

A intenção é: **diagnosticar → corrigir → abrir PR → CI validar → humano decidir merge/deploy**. A Lia não recebe autorização implícita para publicar código em produção.

## Segurança e dados

Toda resposta passa por `filterReply`. Preços só são aceitos quando vieram literalmente dos planos ativos do CRM. Sessões reais usam `<telefone>` e simulações `sim:<telefone>`. Para um JID `@lid`, o bot usa um número alternativo apenas quando o próprio evento do WhatsApp fornece um identificador alternativo confiável (como `remoteJidAlt` ou `senderPn`); caso contrário, preserva o JID completo para envio, sem inventar número. Conversas e mensagens vão para `contacts`, `conversations` e `conversation_messages`; `ai_calls` recebe telemetria sem prompts, respostas ou telefones. O backend mantém dual-write local por segurança e cai automaticamente para os JSON se o Supabase ficar indisponível. Para ativar, configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` e `SUPABASE_SERVICE_ROLE_KEY`, mantendo a última chave somente no ambiente do servidor. `SUPABASE_RUNTIME_ENABLED=false` desliga a migração sem remover o fallback. O arquivo de sessões é retido por 30 dias por padrão e grava atomicamente. Para o volume Docker, use `chown 1000:1000 data`.

As proteções de segurança configuradas para a operação permanecem no código: o painel pode controlar contexto e comportamento operacional, mas não remove os limites de resposta e encaminhamento definidos pelo produto.

## Configuração e execução

```bash
cp .env.example .env
# preencha credenciais somente no .env
npm test
npm run build
npm start
```

O transporte padrão é o WhatsApp nativo via **Baileys** (`WHATSAPP_PROVIDER=baileys`), que faz o pareamento pelo painel e não exige Evolution API. A pasta de sessão pode ser definida em `BAILEYS_AUTH_DIR` (padrão: `./data/baileys-auth`). A integração Evolution permanece apenas como legado opcional: para usá-la, configure explicitamente `WHATSAPP_PROVIDER=evolution`, `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` e `EVOLUTION_INSTANCE`. Sem `WEBHOOK_TOKEN`, o servidor não sobe, exceto com `ALLOW_INSECURE_WEBHOOK=true` em desenvolvimento e host local.

Para iniciar o servidor localmente sem `WEBHOOK_TOKEN`, use somente em desenvolvimento e vincule-o ao loopback. O painel continua exigindo autenticação do Supabase; `ALLOW_UNAUTHENTICATED_DASHBOARD` não habilita acesso anônimo:

```bash
PORT=3000 \
HOST=127.0.0.1 \
WHATSAPP_PROVIDER=baileys \
BAILEYS_AUTH_DIR=./data/baileys-auth \
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
supabase/migrations/20261115000000_prospecting.sql
supabase/migrations/20261115000100_sync_archive.sql
supabase/migrations/20261116000000_review_hardening.sql
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

Antes do deploy, execute `npm ci`, `npm run lint`, `npm run build`, `npm test`, `npm run test:contract` e `git diff --check`. Salve a configuração da Lia e a referência da imagem anterior. Atualize com `docker compose up -d --build bot`, confirme o container com `docker compose ps bot` e valide `curl --fail http://127.0.0.1:3000/health` e `/ready`. No transporte padrão Baileys, confirme o status da conexão e faça o pareamento pelo painel; não configure webhook da Evolution. Somente em instalações legadas que selecionem explicitamente `WHATSAPP_PROVIDER=evolution`, configure `/webhook/evolution`, evento `MESSAGES_UPSERT` e header `Authorization: Bearer <WEBHOOK_TOKEN>`. Para rollback, restaure a imagem/configuração anterior, valide health/readiness e mantenha os volumes de dados.

## Limites operacionais

Confirme os textos comerciais, a política de preços exclusivamente via CRM e o telefone humano na configuração publicada. A semântica exata de `source` da Evolution, `fromMe` e JIDs `@lid` varia por versão/instância e precisa de payload real. Os lembretes de handoff e a manutenção de inatividade são executados pelo timer do servidor; em múltiplas réplicas, deve existir apenas um worker ativo ou um lock distribuído.

A versão atual também coalesce mensagens do webhook dentro de `MESSAGE_DEBOUNCE_MS`, limita o custo por janela, pausa automaticamente quando a Dra. responde pelo celular e executa manutenção de lembretes/inatividade. O dashboard atualiza a cada 5 segundos enquanto a aba está visível e arquiva conversas reais em vez de apagá-las.

### Retomada do bot após atendimento humano

Quando uma sessão está em atendimento humano, o cliente pode enviar `bot`, `voltar` ou `reativar`; o fluxo grava a retomada no store ativo, com `conversations` como fonte primária e `sessions.json` como fallback. Essa opção fica ativa por padrão (`HUMAN_ALLOW_CLIENT_RESUME=true`) e pode ser desligada explicitamente com `false`. O responsável também pode enviar `bot <telefone>` a partir do número publicado em `bot_config_state.active_config.human.phone`; esse comando é processado antes da lógica de `fromMe`, evitando que seja confundido com uma nova tomada de controle humano.
