# Release 3.2.0 — Google Workspace REST, Autonomia Recorrente, Memória PARA & Resiliência de IA/VPS

Data: 2026-11-22

## Resumo

A versão **3.2.0** consolida 5 pacotes de evolução inspirados em padrões maduros de orquestração autônoma, mantendo o motor leve para VPS de 4 GB RAM:

1. **Pacote 1 — Suite Google Workspace via REST puro (`src/tools/google_http.mjs`, `src/tools/gerenciar_gmail_google.mjs`, `src/tools/gerenciar_agenda_google.mjs`, `src/tools/gerenciar_drive_google.mjs`):**
   - Cliente HTTP endurecido com allowlist de hosts/prefixos do Google, bloqueio de path traversal e redirects (`redirect: 'manual'`), limite de 15 MB, timeout de 20s e retry seguro **somente em leituras** (`GET` em 502/503/504) — nunca repetindo escritas.
   - Nova ferramenta exclusiva do dono **`gerenciar_gmail_google`**: `buscar_mensagens`, `ler_mensagem` (decodifica MIME/HTML limpo), `listar_rascunhos` e `criar_rascunho` (seguro: nunca envia nem apaga e-mails).
   - **Google Calendar `sugerir_horarios`:** pesquisa `/freeBusy` em múltiplos dias (até 14 dias), pula blocos ocupados/passados e sugere janelas livres dentro do expediente.
   - **Google Docs `atualizar_documento`:** permite ao dono anexar ou substituir texto em Google Docs via `batchUpdate`.

2. **Pacote 2 — Resiliência Operacional, Segurança e Anti-Sumiço (`src/ops/log-redaction.mjs`, `src/ops/event-loop-monitor.mjs`, `src/safety.mjs`, `src/copilot-tasks.mjs`):**
   - **Redação de segredos em logs:** mascara automaticamente chaves de API (`AIza...`, `gsk_...`, `sk-...`, `nvapi-...`), tokens `Bearer`, JWTs, chaves privadas PEM e credenciais em URLs.
   - **Monitor de Event Loop:** detecta travamentos (> 2s), classifica causa (`main_thread_cpu`, `host_suspended`, `blocked_off_cpu`), expõe métricas em `/ready` (`event_loop`) e em `consultar_saude_infra`.
   - **Guarda anti-links inventados:** remove URLs fictícias/locais (`localhost`, `127.0.0.1`, `*.local`, `seu-dominio.com`) e reescreve rotas conhecidas da Lia (`/pix/...`, `/pay/...`) quando `ownOrigin` estiver definido.
   - **Recuperação no startup:** `recoverInterruptedOnStartup()` re-enfileira imediatamente tarefas somente-leitura interrompidas por restart do container e marca escritas como `uncertain` com notificação pendente ao dono.

3. **Pacote 3 — Autonomia Completa com Scheduler Dedicado de 15s e Rotinas Recorrentes (`src/runtime/schedule-parser.mjs`, `src/runtime/index.mjs`, `src/flow/owner.mjs`, `src/server.mjs`):**
   - **Scheduler dedicado de 15s** no `Lia Runtime` (independente do ciclo longo de manutenção de inatividade) e correção do `claimNextNotification` no Supabase para entregar também notificações `failed`/`uncertain`.
   - **Agendamento determinístico em linguagem natural** para tempo relativo (*"daqui a 2 minutos"*), horário fixo (*"hoje às 15h"*, *"amanhã às 9h"*) e **rotinas recorrentes** (*"todo dia às 8h"*, *"toda segunda às 9h"*, *"a cada 2 horas"*) com auto-reagendamento ao concluir.
   - Suporte autônomo a **Saúde/Infra**, **Gmail** (e-mails não lidos), **Agenda do dia**, **Google Sheets**, **Pesquisa Web** e lembretes proativos, além de comandos rápidos para **listar** (*"quais tarefas estão agendadas?"*) e **cancelar** (*"cancela #ID"*).
   - Expansão de `claimsUnexecutedToolWork` para bloquear promessas falsas de `"Agendado!"` sem execução real.

4. **Pacote 4 — Memória Estruturada PARA + Painel Visual (`src/core/memory.mjs`, `src/http/runtime-routes.mjs`, `public/index.html`, `public/app.js`):**
   - Classificação automática no padrão **PARA** (`project`, `area`, `resource`, `archive`) com contadores, busca, edição e exclusão definitiva.
   - Nova seção **Memória Estruturada (PARA)** na aba **Lia Runtime** do painel (acesso `admin` via `/api/dashboard/memories`).

5. **Pacote 5 — Recibos de Progresso no WhatsApp, Formatação Limpa e Smart `Retry-After` (`src/whatsapp/baileys-provider.mjs`, `src/whatsapp.mjs`, `src/ai/state.mjs`, `src/ai/call.mjs`, `src/safety.mjs`):**
   - **Reações de progresso no WhatsApp:** via Baileys Nativo, a Lia reage com `⏳` ao iniciar ferramentas no Copiloto e troca para `✅` (ou `⚠️`) ao concluir.
   - **Resiliência de modelos de raciocínio e `Retry-After`:** controle de `reasoning_effort: 'low'` (Groq `gpt-oss`) e `reasoning: { effort: 'low' }` (OpenRouter `:free`), `max_tokens` mínimo `2048` contra `finish_reason=length`/`empty_reply`, e leitura do header HTTP `Retry-After` (ou `"try again in Xs"`) para abrir o circuit breaker pelo tempo exato da cota e acordar a fila silenciosa `pendingAIRetry` assim que o provedor libera.
   - **Formatação WhatsApp limpa:** `convertMarkdownTablesToBullets()` em `filterReply()` converte tabelas Markdown `|---|---|` em listas com bullets legíveis no celular e os resumos do worker usam fuso de Brasília (`America/Sao_Paulo`).

## Validação
- **511/511** testes automatizados passando (`npm test`).
- **43/43** verificações de contrato (`node scripts/contract-check.mjs`).
- **`/ready`** validado em produção com todos os **8 checks** (`whatsapp`, `supabase`, `ai`, `copilot_tasks`, `lia_runtime`, `lia_learning`, `lia_autonomy`, `event_loop`) em estado `ready`.
