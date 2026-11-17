# Release 2.5.1 — Hardening de prospecção, privacidade e confiabilidade

A release 2.5.1 consolida as correções da revisão operacional do motor de prospecção e atualiza a documentação interna da Lia para refletir os limites reais do scheduler.

## Segurança e privacidade

- RLS habilitado nas tabelas `prospect_lists`, `prospect_cadences`, `prospect_leads` e `prospect_events`, sem policies para `anon`/`authenticated`; o acesso operacional fica restrito ao `service_role`.
- Opt-out contextual: um contato em atendimento ativo não é interceptado por uma palavra de saída destinada à prospecção.
- Confirmação de opt-out enviada antes da persistência da supressão.
- Telefones em logs com mascaramento reforçado.
- Guards de sessão sem criação de sessões vazias.

## Scheduler e cadências

- Claims temporários recuperáveis e liberação de claims órfãos.
- Retry com backoff exponencial para falhas transitórias.
- Pausa configurável entre mensagens e proteção contra ticks concorrentes.
- Contagem diária paginada no fuso local da operação.
- Fila que continua procurando leads elegíveis quando um lead está aguardando retry.
- Cadências por etapas: cada passo usa seu template e agenda o próximo `next_action_at`.
- Falha de persistência após envio não gera reenvio nem converte sucesso do WhatsApp em `failed`.

## Atualização e validação

1. Aplicar as migrations pendentes na ordem indicada em [`../supabase/README.md`](../supabase/README.md), especialmente `20261116000000_review_hardening.sql`.
2. Confirmar que `SUPABASE_SERVICE_ROLE_KEY` existe somente no processo backend; não expor essa chave ao navegador.
3. Validar com `npm ci`, `npm run lint`, `npm test`, `npm run test:contract`, `npm run build` e `git diff --check`.
4. Para testar prospecção, usar dry-run/test mode e contatos de simulação. Não executar um tick real sem confirmar consentimento, janela, teto diário e supressões.

A validação desta release passou com 296 testes automatizados, 26 contratos de arquitetura e 142 módulos verificados.
