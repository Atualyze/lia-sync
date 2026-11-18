# Guia e Modelo para Novas Bases de Conhecimento

Este arquivo (`README.md`) é ignorado automaticamente na indexação da Lia para não gastar contexto. Use o modelo abaixo ao criar novos arquivos `.md` dentro das pastas.

## Organização das pastas
- `autoconhecimento/` — regras internas da própria Lia (use `<!-- scope: copilot-only -->`).
- `suporte_tecnico/` — manuais e dossiês de sistemas/produtos (ex.: `clubinho-homevet.md`, `registrofacil-v3-17-7.md`).
- `sales_intelligence/` — guias de comunicação, qualificação, objeções e vendas.
- `biblioteca_juridica/` — guias de LGPD, CDC e conformidade.

---

## Modelo recomendado para copiar

> Se o arquivo for **exclusivo do Copiloto/Admin** (nunca deve aparecer para clientes), mantenha `<!-- scope: copilot-only -->` na **primeira linha**. Para bases de atendimento/suporte a clientes, remova essa linha.

```markdown
# Nome do Sistema ou Assunto

Versão: 1.0

> Resumo curto em 1 frase do que esta base cobre (ex.: Manual operacional do Sistema X para suporte a clientes).

---

## 1. Visão Geral e Onde Acessar
- O que é o sistema/serviço e para quem se destina.
- Como o usuário acessa (menu, tela inicial, login).

## 2. Principais Funcionalidades (Passo a Passo)
### 2.1. Nome da Funcionalidade
1. Passo 1 (ex.: Clique em **Menu > Opção**).
2. Passo 2.
3. Resultado esperado.

## 3. Dúvidas Frequentes e Erros Comuns
- **Erro ou dúvida X:** o que significa e como o usuário resolve.
- **Erro ou dúvida Y:** o que verificar antes de acionar o suporte.

## 4. Limites e Quando Encaminhar para Humano
- O que a Lia **não** deve inventar ou prometer neste assunto.
- Situações que exigem transferência imediata para o responsável.
```

## Boas práticas para a busca automática
1. Use nomes de arquivo limpos em minúsculas sem acento (ex.: `sistema-clinica.md`).
2. Coloque palavras-chave reais do cliente nos subtítulos `##` (a busca dá peso maior ao `# Título` e aos `## Subtítulos`).
3. Evite colocar rotas de código interno (`/api/...`), nomes de tabelas do banco ou arquivos de servidor.
4. Registre claramente o que depende de uma ferramenta externa, o que deve ser confirmado somente após sucesso e quando a Lia deve encaminhar para uma pessoa. A base orienta o raciocínio, mas não substitui o resultado real de agenda, pagamento, estoque ou persistência.
