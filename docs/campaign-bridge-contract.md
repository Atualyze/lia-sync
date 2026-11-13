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
- `POST /api/bridge/campaigns/:id/execute` executa no máximo um lote seguro (10 destinatários por chamada), atualizando cada destinatário para `sent` ou `failed` somente após o provedor confirmar ou falhar.

Estados da campanha: `pending`, `running`, `paused`, `completed`, `cancelled`. Estados do destinatário: `pending`, `sent`, `failed`. O worker não inventa sucesso e limita cada execução a 10 destinatários; a ligação a uma fonte canônica de opt-out ainda depende da tabela/política de opt-out do ambiente e permanece uma pendência explícita desta tranche. A migração mantém RLS e não expõe escritas ao browser.

A migração `20261112210000_campaigns_bridge.sql` é aditiva e deve ser aplicada explicitamente em ambiente controlado. Não foi executada nesta tranche. Sem Supabase configurado, o endpoint responde `503 campaign_persistence_unavailable`; não há falso sucesso nem fallback local para campanhas.
