# Release 3.1.0 — WhatsApp Nativo (Baileys), Provedores Customizados e Continuidade entre Modelos

**Data:** 21/11/2026  
**Escopo:** Motor WhatsApp embutido de baixo consumo, provedores de IA customizados com hot-reload, diagnóstico real de falhas e continuidade conversacional entre trocas de modelo/fallback.

## 1. WhatsApp Nativo via Baileys (`src/whatsapp/baileys-provider.mjs` e `src/whatsapp/baileys-auth.mjs`)
- **Transporte WebSocket direto na Lia:** elimina a dependência obrigatória de containers externos (Evolution API + PostgreSQL dedicado), reduzindo o consumo de RAM na VPS em ~150 MiB e a CPU ociosa para `<1%`.
- **Conexão pelo painel:** suporte a **QR Code** e **Pairing Code**, exibição de status em tempo real (`connected`, `qr`, `connecting`, `disconnected`), número conectado, métricas de mensagens e desligamento limpo da entrada legada da Evolution API quando `WHATSAPP_PROVIDER=baileys`.
- **Otimizações P0 e P1 de produção:**
  - `syncFullHistory: false` e `shouldSyncHistoryMessage: () => false` (não duplica o histórico do WhatsApp em RAM).
  - **Message Gate** antes da IA (`evaluateBaileysMessageGate`): descarta duplicadas por ID em cache LRU O(1), broadcasts/status, eventos de presença/recibos irrelevantes, grupos não autorizados e downloads automáticos de mídia.
  - **Auth State enxuto e persistente (`createLiaBaileysAuthState`):** substitui milhares de arquivos individuais por um único `auth-snapshot.json` atômico com `BoundedLruCache` para chaves Signal e backup automático em `runtime_projections` (`baileys_auth_creds`) no Supabase.
  - **Reconexão transparente em `515 (restartRequired)`:** trata reinício pós-pareamento sem resetar o estado para QR Code e ignora eventos de sockets obsoletos.

## 2. Provedores de IA Customizados, Hot-Reload e Diagnóstico Real
- **Provedores OpenAI-Compatible (`src/ai/custom-providers.mjs`):** cadastro, teste e priorização de provedores customizados diretamente pelo painel, com roteamento por prioridade e cálculo aprimorado de custos.
- **Hot-Reload de Credenciais (`src/api-settings.mjs`):** atualização de chaves e parâmetros de provedores com persistência segura em `runtime_projections` (coluna `key`) sem exigir rebuild.
- **Diagnóstico real e orçamento de deadline (`src/ai/errors.mjs`, `src/ai/call.mjs`):**
  - Particionamento de deadline entre provedores de contingência (máximo de 60% do tempo restante, teto de 15s por provedor quando há reservas na fila), evitando que um timeout no provedor primário impeça o fallback.
  - Relato transparente ao Copiloto quando todos os provedores falham (`providerFailureDiagnosticReply` / `getRecentAIErrorSummary`).
  - Proteção no Copiloto contra chamadas indevidas de `gerar_cobranca_pix` em saudações simples.

## 3. Continuidade de Conversa entre Modelos e Fallbacks
- **Âncora explícita no System Prompt (`src/knowledge.mjs`):** bloco `[CONTINUIDADE_ENTRE_MODELOS_E_TURNOS]` injetado tanto no modo **Copiloto** quanto no modo **Cliente** sempre que a conversa já está em andamento, trazendo resumo ativo, estado estruturado, última fala da Lia e as últimas 4 trocas com proibição estrita de reapresentação.
- **Preservação de histórico no Copiloto (`src/flow/owner.mjs`):** `new_request` limpa apenas a tarefa pendente sem apagar `recentHistory`; `contextSummary` e `conversationState` passam a ser persistidos entre turnos.
- **Janelas de histórico sem perda de contexto (`src/ai/parsing.mjs`, `src/ai/call.mjs`):** `normalizeHistory` e `compactCloudflareHistory` preservam turnos da assistente mesmo quando o recorte da janela inicia em `role: 'assistant'`.
- **Filtro anti-reapresentação (`src/safety.mjs`):** `stripRedundantSelfIntroduction` remove prefixos de primeiro contato caso um modelo reserva tente reiniciar uma conversa ativa.

## 4. Painel de Autonomia & Runtime
- Novas visualizações dedicadas no dashboard (`public/index.html`, `public/app.js`) para acompanhar o estado do **Lia Runtime**, **Autonomia**, **Provedores de IA** e a conexão nativa do **WhatsApp (Baileys)**.

## Validação
- `npm run lint` (217 módulos verificados)
- `npm run build` (frontend empacotado em `dist/`)
- `npm run test:contract` (43/43 contratos `PASS`)
- Regressões dedicadas de continuidade entre modelos e `normalizeHistory` em `src/knowledge.test.mjs` e `src/client-natural-context.test.mjs`
