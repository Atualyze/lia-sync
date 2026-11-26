# Release 2.2.2 — Widget Turnstile compartilhado

> Nota de manutenção: a release `2.2.3` passou a montar o widget Turnstile somente depois que a tela de login fica visível. Isso evita o estado `Verifying...` sem `captcha_token`.

O dashboard usa o widget Turnstile existente com a site key pública configurada por `SUPABASE_CAPTCHA_SITE_KEY`. O token gerado no login é enviado ao Supabase; o secret não entra no código, no bundle ou no repositório.

Em produção, o widget deve autorizar `crm.atualyze.com.br` e `crm.atualyze.com.br`. O secret correspondente fica em **Supabase → Authentication → Bot and Abuse Protection**.

Validação:

```bash
npm run build
npm test
npm run test:contract
```
