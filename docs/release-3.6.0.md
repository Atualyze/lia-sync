# Release 3.6.0 — Agenda Unificada, Raio-X da Lia, Setores/Triagem Reais & Hardening

Data: 2026-11-27

## Resumo

A versão 3.6.0 unifica agendamentos, retornos WhatsApp e Google Calendar em um novo menu **Agenda**, adiciona o **Raio-X da Lia** em tempo real no Inbox, corrige de ponta a ponta o fluxo de **Setores / Triagem / Handoff** e consolida uma bateria completa de segurança, persistência e qualidade de código.

## Principais entregas

### 1. Agenda Unificada (`src/agenda.mjs`, `src/http/agenda-routes.mjs`)
- Novo menu **Agenda** no painel (`data-view="agenda"`), reunindo **Reuniões / Horários Marcados** (`AgendaStore` em `data/agenda.json` + `runtime_projections` -> `agenda_events`), **Retornos WhatsApp** (`ReminderStore`), **Rotinas da Lia** (`lia_commitments`) e **Google Calendar** (espelho opcional quando conectado).
- Criação, confirmação, conclusão e cancelamento direto pelo painel, atualizando automaticamente o funil do contato no CRM para `agendado` (respeitando `notALead`).

### 2. Raio-X da Lia no Inbox (`src/ai/call.mjs`, `src/knowledge.mjs`, `src/flow/client.mjs`, `public/app.js`)
- Telemetria por turno (`metadata.lastLiaTrace`) exibida no dossiê lateral do Inbox: modelo/provedor usado (incluindo fallback), latência, tokens, bases de conhecimento acionadas (`suporte_tecnico/`, `sales_intelligence/`, `biblioteca_juridica/`, FAQ, contexto CRM) e ferramentas executadas.

### 3. Setores, Triagem & Handoff Reais (`src/sectors/custom-sectors.mjs`, `src/triage-router.mjs`, `src/tools/transferir_setor.mjs`, `src/flow/client.mjs`)
- `CustomSectorStore` corrigido para o cliente REST do Supabase (`select`/`upsert` em `runtime_projections`, normalização NFD em `sanitizeSectorId`, escrita atômica e rollback em falha).
- Motor (`server.mjs`) mescla a projeção do Chatwoot com `CustomSectorStore`, injetando `promptInstructions` do setor, aplicando `handoffEnabled` e roteando notificações para `responsiblePhone`.
- `transferir_para_setor` agora valida o setor ativo e executa `triggerHandoff` real.
- Classificador `classificarSetorPorTexto` atualizado com pesos por termo, prioridade explícita e resolução direta de IDs customizados (`ouvidoria`, `agendamento`, `triagem`, `copiloto`).

### 4. Segurança, Infraestrutura & Qualidade
- **Pagamentos & Rate Limit:** validação `isIssuedPixLink` em `/pix?p=...` com `crypto.timingSafeEqual`, rate limit público com `TRUSTED_PROXY_HOPS` (`public-rate-limit.mjs`) e persistência atômica de até `5.000` pedidos locais.
- **Segredos & Auth:** suporte a `kid` v2 (`lia-secret:v2:<kid>:...` + `API_SECRETS_PREVIOUS_KEYS`) e comparação SHA-256 em tempo constante para tokens de webhook.
- **Runtime & Docker:** shutdown controlado (`server.close` + `closeIdleConnections` + `forceExit` 12s), `keepAliveTimeout` de `65s`, `evolution-net` opcional no `docker-compose.yml`, fallback `seed-knowledge-bases` no `Dockerfile`, headers `frame-ancestors 'none'` / `X-Frame-Options: DENY` e `ETag`/`304`.
- **Qualidade:** ESLint 10 com `--max-warnings=0`, testes isolados em `os.tmpdir()` (`scripts/test-setup.mjs`), `.editorconfig`/`.gitattributes` (LF) e `740` testes passando.
