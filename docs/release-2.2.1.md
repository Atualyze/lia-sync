# Release 2.2.1 — Consulta web resiliente

## Objetivo

Corrigir o caso em que um modelo aciona `consultar_web` sem preencher o argumento `query`, mesmo quando a mensagem do usuário contém uma solicitação de pesquisa válida.

## Alterações

- O executor recebe `userText` no contexto de ferramentas client e owner.
- A ferramenta usa a mensagem original como fallback somente quando `query` está ausente/vazia.
- Consultas realmente vazias continuam rejeitadas com `INVALID_QUERY`.
- O fallback respeita o limite existente de caracteres e o mesmo fluxo de tratamento de erros.

## Validação

```bash
npm run build
node --test src/consultar-web.test.mjs
```

Commit relacionado: `38a3b23`.
