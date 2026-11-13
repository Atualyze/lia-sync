# Release 2.3.0 — confiabilidade distribuída e operação de IA

## Resumo

A release 2.3.0 completa o catálogo de modelos e a configuração de IA no painel e endurece a coordenação de follow-ups, limites de orçamento e entregas WhatsApp. As configurações continuam publicadas pelo dashboard, com credenciais mantidas somente no servidor.

## Alterações

- Catálogo de modelos consultado pelo backend nas APIs compatíveis de Gemini, OpenRouter, Qwen e OpenAI quando as respectivas credenciais estão configuradas; seleção de um modelo principal e até três modelos de fallback.
- Tool calling nativo integrado ao fluxo configurável, mantendo a execução sob as permissões e validações das ferramentas do motor.
- Limites mensais por provedor/modelo com estimativa prévia, reserva atômica entre instâncias e liquidação usando o provedor/modelo efetivamente utilizado. Tarifas ou consumo desconhecidos não são interpretados como custo zero e podem bloquear novas chamadas dentro do escopo do limite.
- Follow-up protegido por claim atômica no Supabase, token de claim, confirmação após envio e política fail-closed quando a coordenação distribuída não está disponível.
- Deduplicação de webhook mais robusta para eventos que não trazem identificador estável, armazenando hashes e metadados sanitizados em vez do payload.
- Redução do risco de áudio duplicado: não há retry automático quando o estado da entrega é ambíguo; idempotency keys são enviadas ao provedor.
- Correções de regressão no fluxo de IA, orçamento, catálogo, ferramentas, contatos, persistência e timeout do Supabase.

## Banco de dados

Foram incluídas e aplicadas/verificadas no Supabase conectado as migrations:

- `20261113152048_follow_up_atomic_claim.sql`
- `20261113153840_atomic_ai_budgets.sql`
- `20261113154223_ai_budget_effective_model.sql`

As funções RPC de follow-up/orçamento ficam restritas a `service_role`; a tabela de reservas tem RLS habilitado e não expõe políticas de acesso direto. Para outros ambientes, consulte [`../supabase/README.md`](../supabase/README.md) e confirme o histórico antes de aplicar migrations.

## Escopo explicitamente adiado

O item 4 anterior — expansão da busca semântica/base de conhecimento — continua adiado. Esta release não adiciona embeddings, índice vetorial nem um novo pipeline de recuperação semântica.

## Validação

A suíte completa, build, checks de contrato e `git diff --check` foram aprovados. Reexecutar os comandos no checkout atualizado:

```bash
npm ci
npm run lint
npm run build
npm test
npm run test:contract
git diff --check
```

## Deploy e rollback

Após publicar o commit no GitHub, atualizar o serviço pelo Compose existente e verificar `/health` e `/ready` antes de considerar o deploy concluído. Preservar `.env`, volumes e a imagem anterior. Em falha, voltar à imagem/commit anterior e repetir os checks de readiness; não remover dados locais nem desabilitar as migrations já aplicadas.
