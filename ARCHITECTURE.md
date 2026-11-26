# Arquitetura do Lia Sync

Versão: **3.4.0**

## Objetivo

O Lia Sync recebe eventos do WhatsApp (via **Baileys Nativo**, **ManyChat**, **GoHighLevel** ou Evolution API v2 opcional), decide o fluxo de atendimento, usa IA quando aplicável e mantém o painel (incluindo **Funil Kanban**, **Setores**, **Cadências**, **Reputação**, **Ligação Perdida** e **Multi-tenant**) sincronizado. Regras de segurança, autenticação e entrega não dependem de uma resposta de IA.

## Camadas

```text
WhatsApp (Baileys Nativo / Evolution) · Chatwoot · Dashboard
                         │
                    src/server.mjs
                         │
            src/whatsapp/* · src/http/*
                         │
                    src/flow.mjs
                    ├─ flow/client.mjs
                    ├─ flow/owner.mjs
                    ├─ flow/media.mjs
                    └─ flow/pdf.mjs
                         │
    core/* · ai/* · tools/* · runtime/* · learning/* · autonomy/* · safety.mjs
                         │
     Sessions locais / Supabase / Baileys Auth Snapshot
```

## Módulos principais

| Área | Responsabilidade |
| --- | --- |
| `server.mjs` | Inicializa stores, dependências, orçamento de IA, manutenção e servidor HTTP. |
| `http/` | Roteamento, autenticação, webhooks, bridge Chatwoot/SSE, painel e proxy. |
| `http/dashboard.mjs` | Visão operacional autenticada, saúde, operações, modelos, métricas, campanhas e supressões mascaradas. |
| `flow.mjs` | Seleciona atendimento do cliente ou Copiloto do responsável. |
| `flow/client.mjs` | Sessão de cliente, handoff, janela de atendimento, ferramentas permitidas e resposta segura com retorno explícito de agenda/lembretes. |
| `flow/owner.mjs` | Orquestração do Copiloto, confirmação de envios/Pix e delegação para fila persistente. |
| `flow/owner-helpers.mjs` | Funções puras de classificação, extração de argumentos Pix, TTL e controle natural do Copiloto. |
| `flow/owner-commands.mjs` | Comandos determinísticos rápidos do chat interno (`status`, `fila`, `bot`, `humano`, `expediente`, `lembretes`, `ping`, `pdf`). |
| `copilot-tasks.mjs` e `copilot-task-worker.mjs` | Fila persistente idempotente, claim atômico com lease, drenagem imediata e broadcast SSE de resultados. |
| `flow/copilot-continuity.mjs` | Revisão semântica de tool calls: continuação, novo pedido, esclarecimento ou assunto não relacionado. |
| `flow/copilot-tool-plan.mjs` | Valida planos sequenciais do Copiloto, limita a quatro etapas, deduplica chamadas e verifica resultados/recuperação sem retry automático. |
| `tools/index.mjs` | Registro executável `ALL_TOOLS`, schemas reais, aliases, allowlist de cliente, catálogo dinâmico e perfis de risco/autorização. |
| `operations.mjs` | Persistência de auditoria administrativa e de chamadas de ferramentas com metadados sanitizados. |
| `flow/media.mjs` | Transcrição de áudio recebido e resposta em voz. |
| `flow/pdf.mjs` | Entrega de PDF gerado como documento no WhatsApp. |
| `flow/text.mjs` | Normalização, intenção e humanização de mensagens. |
| `ai/` | Seleção de provedor/modelo, catálogo consultado no backend, chamadas, parsing, busca web, documentos, voz e orquestração de ferramentas. |
| `ai/custom-providers.mjs` e `ai/errors.mjs` | Provedores OpenAI-compatible cadastrados pelo painel, roteamento por prioridade e classificação diagnóstica de falhas de IA. |
| `api-settings.mjs` | Hot-reload e persistência segura de chaves/configurações de API em `runtime_projections` no Supabase. |
| `whatsapp/baileys-provider.mjs` e `whatsapp/baileys-auth.mjs` | Motor WhatsApp Nativo por WebSocket (QR/Pairing Code), Message Gate P0+P1, `BoundedLruCache`, sessão compacta (`auth-snapshot.json`) e backup no Supabase. |
| `ai/catalog.mjs` | Consulta os catálogos de Gemini, OpenRouter, Qwen e OpenAI no servidor, usando credenciais de ambiente e cache temporário. |
| `ai/budget.mjs` | Reserva e liquida orçamento mensal por provedor/modelo; usa RPCs atômicas no Supabase quando disponíveis. |
| `core/identity.mjs` | Identidade configurada no painel e reconhecimento do responsável. |
| `core/messages.mjs` | Mensagens padrão derivadas da identidade publicada. |
| `admin-config.mjs` | Rascunho, publicação, revisão e rollback da configuração. |
| `business-hours.mjs` | Regra canônica do expediente: normalização, janela aberta/fechada, próxima abertura, aviso e resumo projetado para a ponte. |
| `sectors.mjs` | Projeção de runtime dos setores vindos do Chatwoot; valida, limita e persiste em arquivo próprio, sem tocar em rascunho ou revisão. |
| `maintenance.mjs` | Manutenção das sessões e follow-up; reivindica atomicamente o envio no Supabase. |
| `webhook-events.mjs` | Deduplicação/estado de eventos por chaves derivadas e sanitizadas. |
| `sessions.mjs` e `supabase-runtime.mjs` | Estado local, persistência remota e fallback. |

## Configuração publicada

`botConfig` é a fonte para nome da assistente, responsável, empresa, apelidos, tom, telefone humano, mensagens, IA, expediente (`business.hoursConfig`) e comportamento. A alteração é feita no painel, salva como rascunho e só entra no runtime após publicação. A seleção de IA define um provedor e modelo principal, com até três modelos de fallback configuráveis. O backend pode consultar o catálogo do provedor; as chaves permanecem no ambiente do servidor.

O expediente é validado de forma fail-closed antes de publicar, mas avaliado de forma fail-open em tempo de execução: uma configuração corrompida nunca silencia o atendimento. Setores e triagem **não** fazem parte da configuração publicada — chegam do Chatwoot pela projeção de runtime, porque o Chatwoot é o dono desses dados. Ver [`docs/config-bridge-contract.md`](docs/config-bridge-contract.md).

Aliases e textos históricos são aceitos somente para migrar dados e conversas já existentes. Não definem uma pessoa, empresa ou telefone para novas operações.

## Garantias

- Todo texto de saída passa por `filterReply` antes da entrega.
- Webhooks sem autenticação falham fechados, exceto em desenvolvimento explícito.
- Eventos recebidos têm deduplicação; o ledger remoto guarda hash/chave derivada e metadados operacionais, não payloads de mensagem ou segredos.
- Sessões reais e simulações usam namespaces distintos.
- Handoff usa `triggerHandoff`; o fluxo não envia transferências diretamente.
- PDFs e áudios são entregues por adaptadores específicos. Envios de áudio não são repetidos automaticamente quando o resultado da entrega é incerto, evitando duplicidade.
- O Copiloto preserva tarefas ativas com pedido original, última pergunta e ferramentas permitidas; esclarecimentos não executam ações sem relação. Áudios do responsável são transcritos antes de interpretar comandos, e falha de transcrição é tratada sem adivinhação.
- O catálogo de ferramentas é derivado de `ALL_TOOLS`, schemas reais, configuração publicada e permissão do ator; não há inventário de parâmetros paralelo como fonte de execução.
- Planos do Copiloto são limitados a quatro etapas, validados antes da execução, executados sequencialmente e interrompidos diante de falha, não correspondência, alerta de saúde, confirmação pendente ou retorno não verificável.
- A verificação usa retornos estruturados das ferramentas; contexto e texto do modelo não substituem a confirmação do executor. Falhas de leitura podem recomendar revisão antes de nova consulta; ferramentas com efeitos externos não são repetidas automaticamente.
- Chamadas de ferramentas são auditadas em `audit_log` com metadados sanitizados quando o `OperationsStore`/Supabase está disponível. Argumentos, conteúdo de mensagens, telefones em claro e payloads completos não entram nessa trilha; clientes recebem um identificador parcialmente mascarado. Auditoria indisponível não é reportada como sucesso.
- Follow-ups exigem claim atômica no Supabase e confirmação da entrega; sem claim distribuída, o envio é bloqueado.
- Agenda e retornos nunca são confirmados apenas pela intenção da IA: o cliente recebe o resultado da ferramenta, e falhas de consulta/persistência podem acionar `triggerHandoff`.
- Limites mensais podem ser definidos por provedor/modelo. A reserva e liquidação distribuídas são serializadas no banco; consumo ou tarifa desconhecidos não são tratados como custo zero.
- RPCs de follow-up e orçamento são restritas a `service_role`; tabelas operacionais não concedem escrita direta ao browser.
- O dashboard não retorna chaves, tokens, prompts, respostas completas ou telefones sem mascaramento.
- Testes de integração do painel são simulados por padrão e não enviam mensagens reais.

## Escopo adiado

A expansão de busca semântica/conhecimento descrita como item 4 permanece adiada e fora da versão 2.3.0. Esta release não introduz embeddings, índice vetorial ou um novo pipeline de recuperação semântica.

## Desenvolvimento e validação

Requer Node.js 22 ou superior.

```bash
npm ci
npm run lint
npm run build
npm test
npm run test:contract
```

`lint` e `build` executam a verificação de sintaxe dos módulos `.mjs` através de `scripts/check-syntax.mjs`; não exigem ferramentas Unix.

## Persistent Copilot task execution (2.9.0)

The Copilot conversation state and the operational task state are separate. `pendingCopilotTask` preserves conversational continuity; `copilot_tasks` is the durable execution ledger. A tool promise is never evidence that a tool ran.

Eligible plans are validated and persisted with an idempotency key derived from the inbound message identity. The server-owned worker claims jobs through `claim_copilot_task` using a database lease and `FOR UPDATE SKIP LOCKED`, revalidates the current tool policy, executes at most four steps sequentially, checkpoints safe summaries, verifies each result, and stops on the first unverified/no-match result. Terminal success, failure, expiry, and uncertainty are separately persisted and reported to the owner.

The worker allowlist is limited to read-only queries and explicitly authorized Pix creation. Read-only leases may be retried within the configured attempt limit. Pix creation is a single-step task with retry policy `never`, enforced in application code and by database constraints. Ambiguous external effects and ambiguous WhatsApp notification delivery become `uncertain`; neither is automatically replayed. A created Pix charge is not evidence of payment.

Supabase is required when configured: if the task table/RPC is unavailable, queue operations fail closed and `/ready` reports `copilot_tasks` unavailable. Local JSON persistence is used when Supabase is not configured; opting into local fallback with Supabase configured requires `COPILOT_TASK_LOCAL_FALLBACK=true` and exactly one replica. Pending local jobs block cutover to Supabase until reconciled. The local task file is stored under the data directory and included by the recursive data backup.

## Lia Runtime Foundation (Parte 1/3)

O **Lia Runtime** (`src/runtime/*`) introduz continuidade operacional persistente separada das sessões de usuário, do histórico de mensagens e das tarefas individuais:

- **`src/runtime/store.mjs`**: persistência backend-only no Supabase (`lia_identity`, `lia_goals`, `lia_events`, `lia_commitments`, `lia_runtime_state` via `20261121100000_lia_runtime.sql`) com fallback local atômico em `data/lia-runtime.json` quando o Supabase não está configurado (ou via `LIA_RUNTIME_LOCAL_FALLBACK=true` em instância única). Falha fechado se o armazenamento estiver indisponível ou corrompido.
- **`src/runtime/identity.mjs`**: identidade operacional persistente da Lia (`identity`, `role`, `principles`, `operating_mode`, `owner_preferences`, `current_status`, `active_objectives`, `active_commitments`, `watched_items`).
- **`src/runtime/goals.mjs`**: Goal Engine com ciclo de vida (`draft`, `active`, `paused`, `completed`, `cancelled`, `failed`), indicadores, prazos, progresso e vínculo com tarefas da `copilot_tasks`.
- **`src/runtime/events.mjs`**: Event Engine e Event Dispatch com deduplicação idempotente (`deduplication_key`), isolamento de falhas, limite de profundidade causal, retries seguros e recuperação após restart.
- **`src/runtime/attention.mjs`**: Attention Engine determinístico (zero chamadas de LLM em loop) que pontua relevância, urgência, impacto, risco e oportunidade. Eventos incertos (`task.uncertain`), Pix ou outbound exigem aprovação humana e nunca são executados automaticamente.
- **`src/runtime/commitments.mjs`**: compromissos persistentes (`pending`, `in_progress`, `fulfilled`, `missed`, `cancelled`) que geram eventos `commitment.due` apenas quando pendentes e vencidos.
- **`src/runtime/index.mjs`**: orquestrador com estados observáveis (`idle`, `observing`, `evaluating`, `planning`, `working`, `waiting`, `blocked`, `needs_human`, `recovering`), recuperação por timeout, logs estruturados sanitizados (`runtime.*`), integração ao `/ready` (`lia_runtime`) e wake-up econômico via scheduler distribuído existente (`maintenance` com `claim_maintenance_lease`), delegando qualquer execução segura somente-leitura exclusivamente para `copilot_tasks`.

## Lia Learning Engine (Parte 2/3)

A camada **`src/learning/*`** adiciona aprendizado contínuo e autoaperfeiçoamento controlado ao `Lia Runtime`, sem jamais alterar código de produção, políticas de segurança ou permissões:

- **`src/learning/boundary.mjs`**: política explícita `ALLOW` vs `DENY` (`enforceSelfImprovementBoundary`) e sanitização de privacidade/segredos; propostas bloqueadas viram `improvement_proposal` para revisão humana.
- **`src/learning/store.mjs`**: persistência backend-only no Supabase (`20261121120000_lia_learning.sql`: `lia_experiences`, `lia_knowledge`, `lia_hypotheses`, `lia_strategies`, `lia_experiments`, `lia_regressions`, `lia_relationships`, `lia_improvement_proposals`) com fallback local atômico em `data/lia-learning.json` e TTL para experiências.
- **`src/learning/experience.mjs`**: Experience Store idempotente com filtro de relevância e Feedback Engine com peso maior para correções humanas explícitas.
- **`src/learning/knowledge.mjs`**: Knowledge Store com sistema de confiança (`candidate` → `experimental` → `supported` → `consolidated` / `deprecated` / `contradicted`), isolamento de escopos (`individual`, `relationship`, `business`, `segment`, `global`), desaprendizado com histórico preservado, resolução de conflitos baseada em evidência, Relationship Learning e Regression Knowledge.
- **`src/learning/experiments.mjs`**: Hypothesis Engine, Strategy Registry versionado (estratégias declarativas, não código), Experiment Engine com validação de segurança (opt-out, suppression, outbound guard, bloqueio de Pix e auto-rollback) e Evaluation Engine objetivo.
- **`src/learning/reflection.mjs`**: Reflection Engine com cooldown/cota, fallback determinístico completo em ausência ou esgotamento de créditos de IA (`AI_PROVIDER_CREDITS_EXHAUSTED`), loop de aprendizado limitado e integração ao `/ready` (`lia_learning`).

## Lia Autonomy Engine (Parte 3/3)

A camada **`src/autonomy/*`** integra Runtime e Learning em autonomia operacional auditável e orientada a resultado (ver [`docs/lia-runtime.md`](docs/lia-runtime.md), [`docs/lia-autonomy.md`](docs/lia-autonomy.md), [`docs/lia-learning.md`](docs/lia-learning.md) e [`docs/lia-safety.md`](docs/lia-safety.md)):

- **`src/autonomy/permissions.mjs`**: Permission Engine em 4 categorias (`A` interna, `B` pré-autorizada por organização, `C` confirmação obrigatória, `D` proibida), `AutonomyBudget` configurável por tenant e seletor de custo (`selectCostTier`).
- **`src/autonomy/presence.mjs`**: `PresenceEngine`, `CommunicationGuard` (motivo real, deduplicação, cooldown e teto diário) e `resolveContextualConflict` (bloqueio de afirmação curta sob estado `uncertain` ou ambiguidade).
- **`src/autonomy/verification.mjs`**: `VerificationEngine` (diferencia tentativa de resultado confirmado), `planRecovery` (proíbe retry de efeitos externos/incertos e pausa LLM em `AI_PROVIDER_CREDITS_EXHAUSTED`), `evaluateSystemHealth` e `AutonomyAuditStore` com métricas de Runtime e Sales.
- **`src/autonomy/domains.mjs`**: CRM Ports desacoplados (`LeadProvider`, `ContactProvider`, `CompanyProvider`, `OpportunityProvider`, `ActivityProvider`, `PipelineProvider`), `RelationshipEngine`, `SalesAutonomy` (estados comerciais, scoring por fatores, cadência adaptativa e personalização factual) e `SupportAutonomy`.
- **`src/autonomy/engine.mjs`**: `AutonomyEngine` com contrato de decisão auditável, priorização multi-objetivo anti-starvation, revisão diária proativa (`runDailyReview`) e integração ao `/ready` (`lia_autonomy`). A revisão, iniciada pelo scheduler de 15s, respeita horário/fuso configurados, considera objetivos, compromissos e saúde operacional e permanece silenciosa sem necessidade real.
- **`src/autonomy/store.mjs`**: `lia_proactive_notifications` registra uma reserva antes do envio e usa `deduplication_key` única para impedir repetição após restart ou em réplicas Supabase; o fallback JSON é adequado a uma única instância. A tabela faz parte da migration `supabase/migrations/20261121150000_lia_autonomy.sql` (não há migration nova nesta versão).
- **`src/runtime/index.mjs`**: eventos que exigem decisão humana notificam o administrador com tipo e motivo, sem payload; compromissos preservam o aviso específico. `owner:*` é resolvido pelo servidor para o telefone do responsável.

Na fase operacional documentada em **3.3.0**, CRM permanece fora do escopo de autonomia. A presença de CRM Ports e capacidades legadas no produto não as autoriza neste ciclo.


## Administrative reconciliation of uncertain Copilot effects

Jobs whose external result or WhatsApp notification is `uncertain` are listed in the admin-only Runtime panel. Reconciliation requires evidence and is stored on the job and in `audit_log`. It may confirm execution, confirm notification delivery/non-delivery, or leave the result uncertain. This operation changes only the recorded state; it never claims a job, enqueues work, replays a tool, repeats a Pix charge, or sends a WhatsApp message. Unresolved outcomes remain visible until new evidence permits a later administrative decision.
