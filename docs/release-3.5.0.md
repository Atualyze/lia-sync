# Release 3.5.0 — CRM Inteligente na Lia, Suporte Dedicado por Contato, Inbox CRM-First & Mobile

Data: 2026-11-26

## Resumo

A versão 3.5.0 aprofunda a integração entre o CRM e o motor da Lia, adiciona suporte dedicado por contato com múltiplas bases `.md`, reformula o Inbox com foco em CRM e otimiza a experiência mobile no painel.

## Principais entregas

### 1. CRM Inteligente e Consulta Completa na Lia
- **`consultar_contato_ou_lead` aprimorado:** resolve contatos por telefone, `external_id` ou nome e retorna ficha CRM completa, incluindo `aiContext` (*Contexto para a Lia*), etapa do funil, setor, tags, notas internas e histórico completo da conversa quando solicitado pelo responsável.
- **Resumo de contatos CRM no prompt do Copiloto:** a Lia recebe contexto dos contatos cadastrados para responder perguntas sobre leads/contatos sem depender de busca manual prévia.
- **Respostas citadas (`replyTo`):** preservação do `contextInfo` / `quotedMessage` em mensagens recebidas no WhatsApp (Baileys), simulador e chat interno (`flow.process`).

### 2. Flag "Não é lead" (`notALead`)
- Contatos marcados como **Não é lead** são ocultados do Funil / Kanban, têm follow-ups automáticos bloqueados e recebem instrução explícita no contexto da Lia para tratamento operacional/relacionamento sem abordagem comercial de funil.

### 3. Atendimento Próprio de Suporte (`.md` por contato)
- Contatos com `supportMode` habilitado podem vincular uma ou mais bases `.md` em `data/knowledge-bases/suporte_tecnico/` (`supportKnowledgeBases`), com upload direto na Ficha do Lead.
- Quando ativo, a Lia utiliza prioritariamente as bases vinculadas ao contato durante o atendimento.

### 4. Inbox CRM-First, Sidebar & Otimização Mobile
- **Inbox CRM-First:** filtro por etapa do funil na lista de conversas, faixa CRM rápida no cabeçalho do chat (`#chat-crm-strip`) e dossiê lateral editável na coluna direita.
- **Sidebar limpa:** grupos *Assistente* e *Plataforma* iniciam recolhidos por padrão.
- **Otimização Mobile (`<= 820px` / `<= 640px`):** correção da cascata responsiva da coluna de dossiê, compensação da barra de navegação inferior no `#inbox-view`, faixa CRM com scroll horizontal, modal da Ficha do Lead em coluna única com rolagem interna, filtros empilhados e campos com altura/fonte adequadas para evitar zoom automático no iOS.

## Validação
- `npm run lint`, `npm run build` e `npm run test:contract` aprovados localmente.
- Deploy validado em produção (`/inbox` `200` e `/ready` `ready`).
