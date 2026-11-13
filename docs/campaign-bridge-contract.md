# Contrato de campanhas — Lia Sync

A Lia Sync é a fonte única de verdade para campanhas e jobs de envio. O Chatwoot Lia é apenas painel/proxy: não persiste campanhas em `localStorage`, não chama provedor diretamente e não considera sucesso sem resposta confirmada da Lia Sync.

## Autorização

Todas as rotas `/api/bridge/campaigns*` exigem `Authorization: Bearer $WEBHOOK_TOKEN` (ou o autorizador de bridge configurado). O proxy do Chatwoot mantém o token somente no servidor.

## Rotas

- `GET /api/bridge/campaigns` lista até 100 campanhas.
- `POST /api/bridge/campaigns` cria campanha. Envie `Idempotency-Key` e `{title,message,recipients:[{phone,name}],minDelay,maxDelay}`. Telefones são normalizados e a criação é idempotente.
- `GET /api/bridge/campaigns/:id` consulta campanha e destinatários.
- `POST /api/bridge/campaigns/:id/pause` pausa sem apagar pendências.
- `POST /api/bridge/campaigns/:id/cancel` cancela e impede novos envios.
- `POST /api/bridge/campaigns/:id/execute` executa no máximo um lote seguro (10 destinatários por chamada), atualizando o destinatário conforme o resultado efetivamente conhecido do provedor.

## Estados e regras de envio

Estados da campanha: `pending`, `running`, `paused`, `completed`, `cancelled`. Estados do destinatário: `pending`, `sending`, `sent`, `failed`, `suppressed`.

`phone_suppressions` é a fonte canônica de opt-out/supressão. A execução de campanhas e os envios pelo adaptador central da Evolution verificam essa fonte; destinatários suprimidos são ignorados e marcados como `suppressed`. Se a consulta à fonte de supressão falhar ou não estiver disponível, o envio falha fechado: não se presume consentimento nem sucesso. A verificação e a execução permanecem no backend, não no browser.

As tabelas e os controles são introduzidos pelas migrations `20261112210000_campaigns_bridge.sql`, `20261112220000_phone_suppressions.sql` e `20261113000000_operations_observability.sql`. Ambientes existentes devem confirmar que essas migrations estão aplicadas antes de habilitar campanhas. Campanhas, destinatários e supressões usam RLS; chaves de idempotência não têm acesso direto por políticas do browser.

Sem persistência Supabase, os endpoints de campanha respondem `503 campaign_persistence_unavailable`; não há falso sucesso nem fallback local para campanhas. A busca semântica/conhecimento do item 4 continua adiada e não faz parte deste contrato.
