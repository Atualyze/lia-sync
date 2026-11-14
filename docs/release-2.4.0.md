# Release 2.4.0 — Roteamento por Capacidades, Tool Calling Estruturado, Voz WAV e Visão Multimodal

## Resumo da Versão

A versão **2.4.0** revisa de ponta a ponta o motor cognitivo e operacional do **Lia Sync**, resolvendo gargalos de latência, conflitos da API Gemini `v1beta` com Structured Outputs + Tool Calling, empacotamento de áudio PCM em WAV, autenticação OAuth2/Service Account no Google Calendar, leitura multimodal de PDFs e fotos com memória na sessão e isolamento da projeção de setores em tabela dedicada.

## Principais Entregas

1. **Roteador Autônomo de Modelos e Capacidades (`src/model-router.mjs`):**
   - Matriz explícita `MODEL_CAPABILITIES` e função `detectarCapacidadesExigidas` (`fast_chat`, `tools`, `web_search`, `document_context`, `deep_reasoning`).
   - Impede que mensagens curtas que exigem busca web, agendamento, lembretes, CRM ou leitura de documento caiam no modelo `lite`.
   - Ajuste dinâmico de `thinkingBudget` (`0` para baixa latência operacional no `lite`/`flash` e `1024` para raciocínio estratégico no `pro`).
   - Fallback multi-modelo corrigido no OpenRouter e downgrade gracioso de `tools` nativo quando um modelo `:free` retorna `HTTP 400/404`.

2. **Tool Calling Estruturado de Passo Único (`src/ai/call.mjs` e `src/ai/parsing.mjs`):**
   - Resolução do conflito `HTTP 400 INVALID_ARGUMENT` na API Gemini `v1beta` ao combinar `responseSchema` com `tools`.
   - Tipagem completa de `responseSchema.properties.tool_calls.items.properties.args` e injeção enxuta do `[CATÁLOGO DE FERRAMENTAS ATIVAS]` para preenchimento de `tool_calls` já na primeira chamada.
   - Unificação de aliases de ferramentas (`agendar_retorno` ↔ `agendar_retorno_ou_followup`, `consultar_contato` ↔ `consultar_contato_ou_lead`).

3. **Leitura Multimodal de PDFs/Imagens e Memória de Sessão (`src/ai/documents.mjs`, `src/flow/owner.mjs`, `src/flow/client.mjs`, `src/http/bridge-routes.mjs`):**
   - Limite de payload na ponte `POST /api/bridge/message` ampliado para **15 MB** e suporte a envio de mídia sem legenda.
   - Fallback automático entre modelos multimodais reais (`gemini-2.5-flash` -> `gemini-flash-latest` -> `gemini-2.0-flash`).
   - Retenção de `lastAnalyzedDocument` na sessão e injeção de `[ULTIMO_DOCUMENTO_ANALISADO_NA_SESSAO]` para responder perguntas de acompanhamento (`"Leia o documento"`, `"Qual o valor?"`).
   - Visão multimodal ativa também para fotos enviadas por clientes no WhatsApp (`mediaType === 'image'`).

4. **Voz TTS Realista com Empacotamento RIFF/WAV (`src/ai/voice.mjs`):**
   - Adicionada `pcm16ToWavBase64` para encapsular o áudio PCM `audio/L16` (24 kHz, 16-bit mono) do Gemini TTS em container RIFF/WAV válido para a Evolution API e navegadores.
   - Removido o campo inválido `speakingRate` do `voiceConfig` na API `v1beta` e priorizado `gemini-2.5-flash-preview-tts`.

5. **Google Agenda & Pesquisa Web (`src/tools/gerenciar_agenda_google.mjs`, `src/ai/search.mjs`):**
   - Suporte a renovação automática de token via OAuth2 Refresh Token (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`) e Service Account JWT (`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`).
   - Correção do endpoint `/freeBusy` na API v3 do Google Calendar e parser de datas (`hoje`, `amanhã`, `DD/MM/YYYY`, `YYYY-MM-DD`) ancorado em `America/Sao_Paulo`.
   - Pesquisa web via Google Search Grounding atualizada para `gemini-2.5-flash` com cobertura expandida de intenções em tempo real.

6. **Persistência e Isolamento de Projeções (`supabase/migrations/20261114072000_runtime_projections.sql`, `src/supabase-runtime.mjs`):**
   - `SectorProjection` isolado na tabela `public.runtime_projections`, sem tocar em `bot_config_state`.
   - `SupabaseSessionStore.syncSession` protege alterações locais pendentes (`dirty`) e evita ressuscitar sessões limpas.

## Validação

- `npm run build`: 108 módulos verificados.
- `npm run test:contract`: 26 contratos arquiteturais aprovados.
- `npm test`: 218 testes automatizados aprovados (0 falhas).
