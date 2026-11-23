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

## Scheduler da revisão diária e intervenção humana (v3.3.0)

- O servidor mantém o wake-up do Runtime e um scheduler dedicado de 15 segundos. Depois do horário `owner_preferences.digestHour` (padrão: **09:00**), cada instância tenta executar a revisão uma vez por data local; o fuso vem da configuração de expediente ativa e, se inválido/ausente, usa `America/Sao_Paulo`.
- `runDailyReview` examina objetivos ativos, compromissos pendentes/atrasados/incertos e sinais de saúde operacional. Sem pendência relevante, registra a revisão como suprimida e não envia mensagem artificial.
- Revisões que precisam chegar ao responsável usam o destinatário `owner:*`, roteado para o telefone humano configurado e submetido ao filtro de saída. O resumo é operacional; payloads de eventos não são encaminhados.
- Eventos que exigem decisão humana também geram pedido de revisão com tipo e motivo, sem o payload. Compromissos mantêm o fluxo de notificação dedicado.
- Uma reserva em `lia_proactive_notifications` é gravada antes do envio. A chave única do Supabase evita duplicidade entre réplicas e persiste através de reinicializações; o fallback em arquivo é para uma única instância. A tabela pertence à migration `20261121150000_lia_autonomy.sql`; o release 3.3.0 não acrescenta migration.

## Recuperação após Restart

Ao reiniciar (`runtime.start()` / `runtime.wake()`):
1. Carrega identidade, objetivos, compromissos, eventos pendentes e estado do Runtime.
2. Detecta estado `working`/`evaluating`/`planning` expirado além de `workingTimeoutMs` e transita por `recovering` → `idle`.
3. Recupera eventos presos em `processing` sem reexecutar efeitos externos incertos.
4. Delega qualquer tarefa somente-leitura elegível exclusivamente para `copilot_tasks`.
