# Release 2.3.2 — runtime configurável

## O que mudou

O motor passa a expor e consumir parâmetros operacionais que antes estavam fixos no código: modo do agente, tool calling, roteamento automático, tamanho do contexto enviado à IA, retenção de histórico, velocidade e timeout de voz, além da ativação, fuso e duração padrão do Google Calendar.

O formulário grava automaticamente o rascunho por meio de `PATCH /api/admin/config/draft`. As mudanças não entram no runtime até a publicação. Depois de publicadas, o servidor recarrega o snapshot ativo e os fluxos de cliente e Copiloto usam o mesmo objeto publicado.

## Parâmetros principais

- `ai.agentMode`: `assistente` ou `super_agente`.
- `ai.enableToolCalling`: derivado do modo selecionado no painel.
- `ai.autoRouting`: habilita o roteamento por complexidade.
- `ai.contextTurns`: quantidade de registros enviados ao modelo.
- `ai.maxStoredHistory`: retenção máxima por sessão.
- `voice.voiceName`, `voice.speed`, `voice.requestTimeoutMs` e `voice.autoVoiceOnAudio`.
- `integrations.googleCalendar.enabled`.
- `integrations.googleCalendar.timezone`.
- `integrations.googleCalendar.defaultEventDurationMinutes`.

## Agenda

A agenda não exibe slots fictícios em produção quando não há token OAuth ou chave configurada. O painel pode desativar a integração, e o motor informa o erro real ao responsável.

## Validação

A configuração é validada antes de publicação. A release foi validada com lint, contratos e 194 testes automatizados aprovados.
