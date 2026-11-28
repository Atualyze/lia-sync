# Release Notes — Lia Sync 3.8.0

## Resumo
A versão **3.8.0** transforma recursos essenciais de CRM, segurança de entrada, disparos seguros, eficiência de cotas de IA e compatibilidade de áudio em **funções nativas da Lia Sync**, sem necessidade de migrações adicionais no Supabase.

## Principais Entregas

### 1. CRM Avançado Nativo (`src/crm/crm-engine.mjs`, `src/crm/stage-automations.mjs`)
- **Notas Privadas Internas:** adicionadas pela ficha do contato (`POST /api/dashboard/crm-note`), exibidas com destaque âmbar e nunca enviadas ao WhatsApp.
- **Timeline Unificada de Atividades:** registra mudanças de estágio, notas privadas, campos customizados e atualizações feitas pela Lia em `atualizar_dados_crm`.
- **SLA de Leads Parados:** calcula o tempo ocioso em estágios ativos (`novo`, `em_atendimento`, `negociacao`) contra `botConfig.crm.slaHours` (padrão `24h`).
- **Campos Customizados & Automações por Estágio:** tags automáticas, agendamento de follow-up e notificação ao admin configuráveis direto na aba CRM do painel.

### 2. Controle de Acesso Granular (`src/access-control.mjs`, `src/http/webhook.mjs`)
- Modos `open`, `whitelist` e `blacklist`, além de controle de grupos (`ignoreGroups`, `allowedGroups`).
- Bloqueia mensagens não autorizadas antes de acionar a IA; o contato do dono (`isOwner`) nunca é bloqueado.

### 3. Safe Broadcast & Ferramenta `gerenciar_campanha` (`src/campaigns.mjs`, `src/tools/gerenciar_campanha.mjs`)
- Lotes configuráveis (`batchSize`, `batchPauseSeconds`) e suporte opcional a mídia (`mediaSender`).
- Ferramenta exclusiva do responsável no Copiloto com confirmação explícita para criar e executar campanhas.

### 4. Cotas Free-Tier & Compressão de Contexto (`src/ai/free-tier-tracker.mjs`, `src/ai/context-compressor.mjs`)
- Compactação de turnos antigos mantendo os últimos turnos intactos para pools com limite de TPM/contexto (`groq`, `nvidia`, `cloudflare`, `openrouter:free`).
- Cooldown automático em HTTP `429` e visualização ao vivo em **Monitoramento & Custos**.

### 5. Áudio Mobile (Ogg Opus PTT), Agenda Nativa & Classificadores
- `azure_speech` e `azure_openai` agora emitem Ogg Opus nativamente; `baileys-provider.mjs` garante container `OggS` para `ptt: true` usando `ffmpeg` instalado no `Dockerfile`.
- `gerenciar_agenda_google.mjs` usa automaticamente a agenda nativa (`AgendaStore`) como fallback quando o Google Calendar não está conectado.
- `askAI` suporta `rawJson: true` para os classificadores internos do Copiloto.

## Validação
- `npm run lint`: 299 módulos verificados.
- `npm run lint:eslint`: 0 erros e 0 warnings.
- `npm test`: **750/750** testes aprovados.
