# Lia Runtime (`src/runtime/`)

O **Lia Runtime** fornece continuidade operacional persistente separada das sessões de conversa, do histórico de mensagens e das tarefas individuais.

## Arquitetura

- `src/runtime/store.mjs`: persistência backend-only no Supabase (`20261121100000_lia_runtime.sql`) com fallback local atômico em `data/lia-runtime.json`. Falha fechado em indisponibilidade ou corrupção.
- `src/runtime/identity.mjs`: identidade operacional persistente (`lia_identity`).
- `src/runtime/goals.mjs`: Goal Engine (`draft`, `active`, `paused`, `completed`, `cancelled`, `failed`) com indicadores, progresso, prazos e vínculo com `copilot_tasks`.
- `src/runtime/events.mjs`: Event Engine idempotente (`deduplication_key`), sanitização de segredos, limite de profundidade causal e recuperação de eventos presos em `processing`.
- `src/runtime/attention.mjs`: Attention Engine determinístico (zero chamadas de LLM em loop) que pontua relevância, urgência, impacto, risco e oportunidade.
- `src/runtime/commitments.mjs`: compromissos persistentes (`pending`, `in_progress`, `fulfilled`, `missed`, `cancelled`) que emitem `commitment.due` no vencimento.
- `src/runtime/index.mjs`: ciclo de vida observável (`idle`, `observing`, `evaluating`, `planning`, `working`, `waiting`, `blocked`, `needs_human`, `recovering`), logs estruturados `runtime.*`, `/ready` (`lia_runtime`) e wake-up via scheduler distribuído `maintenance`.

## Recuperação após Restart

Ao reiniciar (`runtime.start()` / `runtime.wake()`):
1. Carrega identidade, objetivos, compromissos, eventos pendentes e estado do Runtime.
2. Detecta estado `working`/`evaluating`/`planning` expirado além de `workingTimeoutMs` e transita por `recovering` → `idle`.
3. Recupera eventos presos em `processing` sem reexecutar efeitos externos incertos.
4. Delega qualquer tarefa somente-leitura elegível exclusivamente para `copilot_tasks`.
