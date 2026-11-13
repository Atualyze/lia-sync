# Painel operacional central

A partir da versão 2.2.0, o `lia-sync` é a fonte de verdade operacional da Lia. O Chatwoot Lia continua sendo o console de atendimento e a ponte autenticada; ele não deve duplicar ferramentas, regras de campanha, configurações de modelo ou políticas de opt-out.

## Áreas do painel

O painel em `/dashboard` exige autenticação Supabase/JWT e reúne Saúde & Operação, configurações administrativas, modelos/provedores, métricas, campanhas, supressões e auditoria observacional. Rotas administrativas validam o perfil e os papéis permitidos antes de ler ou alterar dados.

Custos monetários são estimativas enquanto não houver uma tabela de preços versionada por provedor/modelo. Tokens, latência, falhas e circuit breakers são métricas operacionais. Telefones de supressão devem permanecer mascarados no browser.

## Teste seguro

O teste de integração padrão é simulado: não envia WhatsApp, não cria conversa real e não dispara handoff. Qualquer operação que execute envio deve passar pelos endpoints autenticados da ponte, com idempotência e verificação de supressão.

## Publicação

Antes de publicar, executar:

```bash
npm ci
npm run build
npm test
node scripts/contract-check.mjs
```

Em produção, confirmar `/health` para liveness e `/ready` para readiness, validar o webhook autenticado e manter a imagem anterior disponível para rollback. O painel só deve ser exposto atrás de HTTPS e com `DASHBOARD_ORIGIN` configurado para o domínio oficial.
