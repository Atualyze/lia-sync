# Arquitetura do Lia Sync

Versão: **2.4.0**

## Objetivo

O Lia Sync recebe eventos do WhatsApp, decide o fluxo de atendimento, usa IA quando aplicável e mantém o painel e as integrações sincronizados. Regras de segurança, autenticação e entrega não dependem de uma resposta de IA. O Lia Sync é a fonte central das configurações, ferramentas, campanhas, supressões, métricas e readiness operacional; o Chatwoot Lia atua como ponte autenticada e console de atendimento.

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
| `server.mjs` | Inicializa stores, dependências, orçamento de IA, manutenção e servidor HTTP. |
| `http/` | Roteamento, autenticação, webhooks, bridge Chatwoot/SSE, painel e proxy. |
| `http/dashboard.mjs` | Visão operacional autenticada, saúde, operações, modelos, métricas, campanhas e supressões mascaradas. |
| `flow.mjs` | Seleciona atendimento do cliente ou Copiloto do responsável. |
| `flow/client.mjs` | Sessão de cliente, handoff, janela de atendimento e resposta segura. |
| `flow/owner.mjs` | Comandos do Copiloto, ações operacionais e confirmação de envio. |
| `flow/media.mjs` | Transcrição de áudio recebido e resposta em voz. |
| `flow/pdf.mjs` | Entrega de PDF gerado como documento no WhatsApp. |
| `flow/text.mjs` | Normalização, intenção e humanização de mensagens. |
| `ai/` | Seleção de provedor/modelo, catálogo consultado no backend, chamadas, parsing, busca web, documentos, voz e orquestração de ferramentas. |
| `ai/catalog.mjs` | Consulta os catálogos de Gemini, OpenRouter, Qwen e OpenAI no servidor, usando credenciais de ambiente e cache temporário. |
| `ai/budget.mjs` | Reserva e liquida orçamento mensal por provedor/modelo; usa RPCs atômicas no Supabase quando disponíveis. |
| `core/identity.mjs` | Identidade configurada no painel e reconhecimento do responsável. |
| `core/messages.mjs` | Mensagens padrão derivadas da identidade publicada. |
| `admin-config.mjs` | Rascunho, publicação, revisão e rollback da configuração. |
| `business-hours.mjs` | Regra canônica do expediente: normalização, janela aberta/fechada, próxima abertura, aviso e resumo projetado para a ponte. |
| `sectors.mjs` | Projeção de runtime dos setores vindos do Chatwoot; valida, limita e persiste em arquivo próprio, sem tocar em rascunho ou revisão. |
| `maintenance.mjs` | Manutenção das sessões e follow-up; reivindica atomicamente o envio no Supabase. |
| `webhook-events.mjs` | Deduplicação/estado de eventos por chaves derivadas e sanitizadas. |
| `sessions.mjs` e `supabase-runtime.mjs` | Estado local, persistência remota e fallback. |

## Configuração publicada

`botConfig` é a fonte para nome da assistente, responsável, empresa, apelidos, tom, telefone humano, mensagens, IA, expediente (`business.hoursConfig`) e comportamento. A alteração é feita no painel, salva como rascunho e só entra no runtime após publicação. A seleção de IA define um provedor e modelo principal, com até três modelos de fallback configuráveis. O backend pode consultar o catálogo do provedor; as chaves permanecem no ambiente do servidor.

O expediente é validado de forma fail-closed antes de publicar, mas avaliado de forma fail-open em tempo de execução: uma configuração corrompida nunca silencia o atendimento. Setores e triagem **não** fazem parte da configuração publicada — chegam do Chatwoot pela projeção de runtime, porque o Chatwoot é o dono desses dados. Ver [`docs/config-bridge-contract.md`](docs/config-bridge-contract.md).

Aliases e textos históricos são aceitos somente para migrar dados e conversas já existentes. Não definem uma pessoa, empresa ou telefone para novas operações.

## Garantias

- Todo texto de saída passa por `filterReply` antes da entrega.
- Webhooks sem autenticação falham fechados, exceto em desenvolvimento explícito.
- Eventos recebidos têm deduplicação; o ledger remoto guarda hash/chave derivada e metadados operacionais, não payloads de mensagem ou segredos.
- Sessões reais e simulações usam namespaces distintos.
- Handoff usa `triggerHandoff`; o fluxo não envia transferências diretamente.
- PDFs e áudios são entregues por adaptadores específicos. Envios de áudio não são repetidos automaticamente quando o resultado da entrega é incerto, evitando duplicidade.
- Follow-ups exigem claim atômica no Supabase e confirmação da entrega; sem claim distribuída, o envio é bloqueado.
- Limites mensais podem ser definidos por provedor/modelo. A reserva e liquidação distribuídas são serializadas no banco; consumo ou tarifa desconhecidos não são tratados como custo zero.
- RPCs de follow-up e orçamento são restritas a `service_role`; tabelas operacionais não concedem escrita direta ao browser.
- O dashboard não retorna chaves, tokens, prompts, respostas completas ou telefones sem mascaramento.
- Testes de integração do painel são simulados por padrão e não enviam mensagens reais.

## Escopo adiado

A expansão de busca semântica/conhecimento descrita como item 4 permanece adiada e fora da versão 2.3.0. Esta release não introduz embeddings, índice vetorial ou um novo pipeline de recuperação semântica.

## Desenvolvimento e validação

Requer Node.js 22 ou superior.

```bash
npm ci
npm run lint
npm run build
npm test
npm run test:contract
```

`lint` e `build` executam a verificação de sintaxe dos módulos `.mjs` através de `scripts/check-syntax.mjs`; não exigem ferramentas Unix.
