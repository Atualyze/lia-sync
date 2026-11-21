# Release 3.0.0 — Lia Runtime, Aprendizado Contínuo e Autonomia Operacional

## Objetivo

Evoluir o **Lia Sync** de um assistente predominantemente reativo a mensagens para uma camada operacional persistente, orientada por objetivos, capaz de observar eventos, acompanhar compromissos, agir dentro de políticas explícitas, verificar resultados e aprender progressivamente com a própria experiência — sem jamais contornar as garantias de segurança existentes.

## Principais Entregas

### Parte 1/3 — Fundação do Lia Runtime (`src/runtime/*`)
- **Persistência durável (`store.mjs`):** tabelas backend-only no Supabase (`20261121100000_lia_runtime.sql`: `lia_identity`, `lia_goals`, `lia_events`, `lia_commitments`, `lia_runtime_state`) com RLS habilitado, `service_role` only e fallback local atômico em `data/lia-runtime.json`.
- **Motores centrais:** `LiaIdentityStore`, `GoalEngine`, `EventEngine` (idempotente com recuperação pós-restart), `evaluateAttention` (determinístico, zero LLM loop) e `CommitmentStore` (`commitment.due`).
- **Orquestração e Readiness (`index.mjs`):** ciclo de vida observável com recuperação por timeout, logs estruturados `runtime.*`, integração ao `/ready` (`lia_runtime`), wake-up econômico via scheduler distribuído `maintenance` e reuso exclusivo de `copilot_tasks`.

### Parte 2/3 — Aprendizado Contínuo e Autoaperfeiçoamento (`src/learning/*`)
- **Fronteira explícita (`boundary.mjs`):** política `ALLOW` vs `DENY` bloqueando alterações de código, segurança, permissões e segredos (gerando `improvement_proposal` para revisão humana).
- **Persistência (`store.mjs`):** migration `20261121120000_lia_learning.sql` (`lia_experiences`, `lia_knowledge`, `lia_hypotheses`, `lia_strategies`, `lia_experiments`, `lia_regressions`, `lia_relationships`, `lia_improvement_proposals`) com fallback local atômico em `data/lia-learning.json` e TTL de privacidade.
- **Motores de aprendizado:** `ExperienceStore`, `FeedbackEngine`, `ReflectionEngine` (cooldown, cota e fallback determinístico em `AI_PROVIDER_CREDITS_EXHAUSTED`), `KnowledgeStore` (confiança, escopos isolados, desaprendizado com histórico e resolução de conflitos), `RelationshipLearningStore`, `RegressionKnowledgeStore`, `HypothesisEngine`, `StrategyRegistry` versionado, `ExperimentEngine` seguro com auto-rollback e `evaluateExperiment`.

### Parte 3/3 — Autonomia Operacional, Presença e Integração (`src/autonomy/*`)
- **Permissões e Orçamento (`permissions.mjs`):** 4 categorias (`A` interna, `B` pré-autorizada por organização, `C` confirmação obrigatória, `D` proibida), `AutonomyBudget` por tenant e `selectCostTier`.
- **Presença e Continuidade (`presence.mjs`):** `PresenceEngine`, `CommunicationGuard` (motivo válido, deduplicação, cooldown e teto diário) e `resolveContextualConflict`.
- **Verificação, Recuperação e Auditoria (`verification.mjs`):** `verifyOutcome`, `planRecovery` (sem retry automático em efeitos externos ou `uncertain`), `evaluateSystemHealth` e `AutonomyAuditStore` com métricas de Runtime e Sales.
- **Domínios e CRM Ports (`domains.mjs`):** interfaces desacopladas (`LeadProvider`, `ContactProvider`, `CompanyProvider`, `OpportunityProvider`, `ActivityProvider`, `PipelineProvider`), `RelationshipEngine`, `SalesAutonomy` e `SupportAutonomy`.
- **Migration (`20261121150000_lia_autonomy.sql`):** `lia_org_autonomy_policies`, `lia_autonomy_decisions`, `lia_sales_states` e `lia_proactive_notifications` (com rollback documentado).

### Hardening Estrutural e Performance
- Graceful shutdown corrigido (`app.drainPending()`) em `src/server.mjs`.
- Fidelidade do ledger de webhooks em lotes de debounce.
- Broadcast SSE e drenagem imediata (`drain()` + `onEnqueue`) no worker do Copiloto.
- Limites de memória em `rate`, `rateWarned` e `outboundDispatchClaims`; remoção da varredura `O(N)` em `SessionStore.archive()`.
- Modularização de `src/flow/owner.mjs` com extração de `src/flow/owner-helpers.mjs` e `src/flow/owner-commands.mjs`.

## Documentação Dedicada
- [`docs/lia-runtime.md`](lia-runtime.md)
- [`docs/lia-learning.md`](lia-learning.md)
- [`docs/lia-autonomy.md`](lia-autonomy.md)
- [`docs/lia-safety.md`](lia-safety.md)

## Validação
- `npm run lint` e `npm run build`: **208 módulos** verificados sem erros.
- `npm run test:contract`: **43/43 contratos** aprovados.
- `npm run test:coverage`: **478 testes** executados, **478 aprovados** (0 falhas).
