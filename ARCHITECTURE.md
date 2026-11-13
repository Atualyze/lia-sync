# Arquitetura do Lia Sync

Versão: **2.2.0**

## Objetivo

O Lia Sync recebe eventos do WhatsApp, decide o fluxo de atendimento, usa IA quando aplicável e mantém o painel e as integrações sincronizados. Regras de segurança, autenticação e entrega não dependem de uma resposta de IA. A partir da 2.2.0, o Lia Sync é também a fonte central das configurações, ferramentas, campanhas, supressões, métricas e readiness operacional; o Chatwoot Lia atua como ponte e console de atendimento.

## Camadas

```text
Evolution / Chatwoot / Dashboard
             │
        src/server.mjs
             │
        src/http/*
             │
        src/flow.mjs
        ├─ flow/client.mjs
        ├─ flow/owner.mjs
        ├─ flow/media.mjs
        └─ flow/pdf.mjs
             │
    core/* · ai/* · tools/* · safety.mjs
             │
 Sessions locais / Supabase / Evolution API
```

## Módulos principais

| Área | Responsabilidade |
| --- | --- |
| `server.mjs` | Inicializa stores, dependências, manutenção e o servidor HTTP. |
| `http/` | Roteamento, autenticação, webhooks, bridge Chatwoot/SSE, painel e proxy. |
| `http/dashboard.mjs` | Visão operacional autenticada, saúde, operações, modelos, métricas, campanhas e supressões mascaradas. |
| `flow.mjs` | Seleciona atendimento do cliente ou Copiloto do responsável. |
| `flow/client.mjs` | Sessão de cliente, handoff, janela de atendimento e resposta segura. |
| `flow/owner.mjs` | Comandos do Copiloto, ações operacionais e confirmação de envio. |
| `flow/media.mjs` | Transcrição de áudio recebido e resposta em voz. |
| `flow/pdf.mjs` | Entrega de PDF gerado como documento no WhatsApp. |
| `flow/text.mjs` | Normalização, intenção e humanização de mensagens. |
| `ai/` | Seleção de provedor, chamadas, parsing, busca, documentos e voz. |
| `core/identity.mjs` | Identidade configurada no painel e reconhecimento do responsável. |
| `core/messages.mjs` | Mensagens padrão derivadas da identidade publicada. |
| `admin-config.mjs` | Rascunho, publicação, revisão e rollback da configuração. |
| `sessions.mjs` e `supabase-runtime.mjs` | Estado local, persistência remota e fallback. |

## Configuração publicada

`botConfig` é a fonte para nome da assistente, responsável, empresa, apelidos, tom, telefone humano, mensagens, IA e comportamento. A alteração é feita no painel, salva como rascunho e só entra no runtime após publicação.

Aliases e textos históricos são aceitos somente para migrar dados e conversas já existentes. Não definem uma pessoa, empresa ou telefone para novas operações.

## Garantias

- Todo texto de saída passa por `filterReply` antes da entrega.
- Webhooks sem autenticação falham fechados, exceto em desenvolvimento explícito.
- Sessões reais e simulações usam namespaces distintos.
- Handoff usa `triggerHandoff`; o fluxo não envia transferências diretamente.
- PDFs e áudios são entregues por adaptadores específicos, com fallback para texto quando a entrega não é possível.
- O dashboard não retorna chaves, tokens, prompts, respostas completas ou telefones sem mascaramento.
- Testes de integração do painel são simulados por padrão e não enviam mensagens reais.

## Desenvolvimento

```bash
npm run lint
npm test
npm run build
```

`lint` e `build` executam a verificação de sintaxe de todos os módulos `.mjs` através de `scripts/check-syntax.mjs`; não exigem ferramentas Unix.
