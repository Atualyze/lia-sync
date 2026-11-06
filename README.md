# 🤖 Lia Bot — Motor Conversacional Inteligente & Triagem Omnichannel

[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-68a063?style=flat&logo=node.js)](https://nodejs.org/)
[![Architecture](https://img.shields.io/badge/Dependencies-Zero%20External%20Runtime%20NPM-blue)](#arquitetura)
[![WhatsApp Engine](https://img.shields.io/badge/WhatsApp-Evolution%20API%20v2-25D366?logo=whatsapp)](https://evolution-api.com)
[![Persistence](https://img.shields.io/badge/Persistence-Supabase%20Runtime-3ECF8E?logo=supabase)](https://supabase.com)
[![CRM Integration](https://img.shields.io/badge/CRM-Chatwoot%20Lia%20Bridge-FF6B6B)](#integração-com-o-chatwoot-lia-crm)
[![License](https://img.shields.io/badge/Platform-Atualyze-6366F1)](https://atualyze.com.br)

O **Lia Bot** é o motor de inteligência artificial conversacional da plataforma **Atualyze** ([atualyze.com.br](https://atualyze.com.br) | [chat.atualyze.com.br](https://chat.atualyze.com.br)). Desenvolvido para atuar com alta disponibilidade, resiliência e rigorosas barreiras determinísticas de segurança, o sistema realiza atendimento executivo, triagem qualificada, transbordo híbrido e gestão operacional 24 horas por dia, 7 dias por semana.

---

## 📑 Sumário

- [Visão Geral](#-visão-geral)
- [Diferenciais de Engenharia](#-diferenciais-de-engenharia)
- [Arquitetura de Segurança Determinística](#-arquitetura-de-segurança-determinística)
- [Estrutura do Projeto](#-estrutura-do-projeto)
- [Copiloto Operacional Interno (`tauan_self`)](#-copiloto-operacional-interno-tauan_self)
- [Integração com o Chatwoot Lia CRM](#-integração-com-o-chatwoot-lia-crm)
- [Persistência e Supabase Runtime](#-persistência-e-supabase-runtime)
- [Provedores de IA e Circuit Breakers](#-provedores-de-ia-e-circuit-breakers)
- [Configuração de Ambiente (.env)](#-configuração-de-ambiente-env)
- [Deploy e Execução](#-deploy-e-execução)
- [Governança e Boas Práticas](#-governança-e-boas-práticas)

---

## 🌟 Visão Geral

A **Lia** atua como a primeira linha de contato com clientes, leads e parceiros da **Atualyze**. Ela combina inteligência generativa com validações rígidas de código, garantindo:

- **Atendimento Humanizado & Ágil:** Respostas contextuais, empáticas e objetivas formatadas com primor para a interface do WhatsApp.
- **Capacidade Multimodal:** Transcrição automática de áudios via Gemini 2.5 Flash / OpenRouter e processamento inteligente de mídias (áudio, imagem e documentos).
- **Triagem Qualificada & Handoff:** Identificação precoce de intenções, coleta de requisitos e encaminhamento imediato para atendimento humano ou setores específicos.
- **Roteamento Setorial Híbrido:** Encaminhamento flexível configurado entre fila web no painel ou alerta direto no WhatsApp de especialistas responsáveis.
- **Copiloto Interno:** Central de comando integrada para gestão de fila, alternância de modo (IA / Humano) e relatórios operacionais em tempo real.

---

## ⚡ Diferenciais de Engenharia

1. **Zero Dependências NPM em Runtime:** Todo o código do bot roda nativamente em **Node.js 22 ESM**, consumindo apenas módulos nativos (`node:http`, `node:https`, `node:crypto`, `node:fs`, `node:test`). Isso garante inicialização em milissegundos, superfície mínima de ataque e zero risco de quebras por dependências externas.
2. **Dual-Store Resiliente:** Operação com gravação simultânea (dual-write) no **Supabase** e em armazenamento atômico local (`sessions.json`). Caso haja oscilação de rede externa, o sistema assume o fallback local sem perda de estado.
3. **Debounce & Deduplicação de Mensagens:** Mensagens consecutivas enviadas pelo cliente em curto intervalo são unificadas via timer de debounce antes de acionar a IA, otimizando o consumo de tokens e a coerência da resposta.
4. **Detecção e Prevenção de Condições de Corrida:** Tratamento rigoroso de eventos `fromMe` e `wasSentByBot`, impedindo loops em que mensagens enviadas pelo próprio sistema disparam novas respostas.

---

## 🛡️ Arquitetura de Segurança Determinística

> [!IMPORTANT]
> **A IA nunca toma decisões de segurança ou regras de negócio críticas.** 
> Todas as entradas e saídas passam por filtros algorítmicos determinísticos independentes antes de qualquer envio.

- **`filterReply`:** Toda resposta gerada pela IA é inspecionada. É expressamente proibido diagnosticar, prescrever medicamentos/dosagens, dar prognósticos clínicos ou prometer valores arbitrários não cadastrados no banco.
- **Validação de Preços:** Valores e planos monetários são aceitos apenas quando correspondem textualmente aos dados ativos no banco de dados (Supabase/CRM).
- **Separação de Namespaces:** Sessões reais utilizam o número telefônico sanitizado (`5586...`), enquanto testes e simulações do painel operam no namespace estrito `sim:<telefone>`, impedindo contaminação de dados.
- **Webhook Fails Closed:** Requisições de webhook sem token ou com assinatura inválida são rejeitadas imediatamente com `401 Unauthorized`.
- **Privacidade e LGPD:** Logs de telemetria nunca registram o texto integral digitado pelo cliente nem números de telefone completos (somente máscara/hash).

---

## 📂 Estrutura do Projeto

```text
lia-bot/
├── src/
│   ├── server.mjs          # Servidor HTTP, roteador de webhooks e reverse proxy para CRM
│   ├── flow.mjs            # Orquestrador do fluxo conversacional, debounce e estados
│   ├── safety.mjs          # Camada de segurança (filterReply, sanitização, regras clínicas)
│   ├── sessions.mjs        # Gerenciamento de sessões, TTL e dual-write (Supabase + local)
│   ├── copilot.mjs         # Copiloto operacional interno (tauan_self) e execução de comandos
│   ├── handoff.mjs         # Regras de transbordo, alertas e encaminhamento setorial
│   ├── whatsapp.mjs        # Cliente HTTP para a Evolution API v2
│   ├── faq.mjs             # Sistema de FAQ dinâmico e base de respostas rápidas
│   ├── persistence.mjs     # Adaptador de persistência (Supabase REST API)
│   ├── ai/
│   │   ├── gemini.mjs      # Integração direta com Google Gemini (REST)
│   │   ├── openrouter.mjs  # Integração com OpenRouter (JSON Schema estrito)
│   │   └── providers.mjs   # Seletor dinâmico de IA, fallback em cascata e métricas
│   └── knowledge/          # Base de conhecimento declarativa e regras de negócio
├── supabase/
│   ├── migrations/         # Schemas SQL (contatos, conversas, configurações, logs)
│   └── seed.sql            # Carga inicial de dados para desenvolvimento
├── tests/                  # Suíte de testes unitários nativos (node:test)
├── Dockerfile              # Imagem de produção otimizada para Node.js 22 Alpine
└── docker-compose.yml      # Orquestração do bot, banco e proxies
```

---

## 🤖 Copiloto Operacional Interno (`tauan_self`)

O sistema conta com um canal de comando e controle exclusivo que permite gerenciar toda a operação diretamente pelo WhatsApp ou pela interface do Chatwoot Lia CRM:

| Comando | Descrição |
| :--- | :--- |
| `status` | Exibe o diagnóstico completo: uptime, sessões ativas, fila humana, modelos de IA ativos e consumo de tokens. |
| `fila` | Lista todos os clientes atualmente aguardando atendimento humano com telefone e link rápido. |
| `bot <número/nome>` | Reativa o atendimento automático da Lia para aquele cliente. |
| `humano <número/nome>` | Pausa a Lia e assume o atendimento manual daquele cliente. |
| `lembretes` | Força a verificação de inatividade e dispara lembretes para atendentes e clientes. |
| `limpar <número/nome>` | Reseta a sessão ativa e o histórico imediato do cliente especificado. |
| `ajuda` | Lista todos os comandos e parâmetros disponíveis. |

---

## 🔗 Integração com o Chatwoot Lia CRM

O **Lia Bot** e o **Chatwoot Lia** operam em conjunto na mesma infraestrutura de rede:

1. **Reverse Proxy Integrado:** O `server.mjs` escuta na porta `3000` e redireciona de forma transparente as requisições de dashboard, assets e APIs do CRM para o container `chatwoot-lia` na porta `4000`:
   - `/` e `/dashboard` ➡️ Interface visual do CRM.
   - `/api/conversations/*`, `/api/contacts/*`, `/api/triage/*`, `/api/channels/*` ➡️ APIs do CRM.
   - `/webhook/evolution`, `/health`, `/api/bridge/*` ➡️ Processamento nativo do bot.
2. **Bridge SSE em Tempo Real (`/api/bridge/events`):** Notifica instantaneamente o CRM sobre novas mensagens, alterações de status e acionamento de transbordo.
3. **Persistência Compartilhada (`chatwoot-system-state`):** Sincronização atômica via Supabase do estado de leitura, conversas resolvidas e configurações operacionais.

---

## 🗄️ Persistência e Supabase Runtime

O bot utiliza o Supabase como camada primária de persistência:

- **`contacts`:** Cadastro consolidado de contatos, nomes, tags e preferências.
- **`conversations`:** Registro de sessões, canal de origem, status (`open`, `human`, `resolved`) e metadados.
- **`conversation_messages`:** Histórico completo de mensagens recebidas e enviadas com timestamps e direção.
- **`bot_config_state` & `bot_config_revisions`:** Configuração operacional versionada com suporte a rascunhos, validação e rollback dinâmico.
- **`ai_calls`:** Telemetria de latência, status e custo de tokens (sem armazenar texto sensível ou PII).

---

## ⚙️ Configuração de Ambiente (.env)

Copie o modelo `.env.example` e preencha as variáveis de ambiente necessárias:

```env
# Servidor
PORT=3000
HOST=0.0.0.0
NODE_ENV=production

# Evolution API (WhatsApp)
EVOLUTION_API_URL=http://evolution-api:8080
EVOLUTION_API_KEY=sua_chave_evolution_aqui
EVOLUTION_INSTANCE=clubinho
WEBHOOK_TOKEN=seu_token_secreto_webhook

# Provedores de Inteligência Artificial
GEMINI_API_KEY=sua_chave_gemini_aqui
OPENROUTER_API_KEY=sua_chave_openrouter_aqui

# Supabase Runtime
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key_aqui
SUPABASE_RUNTIME_ENABLED=true

# Atendimento Humano e Alertas
HUMAN_ATTENDANT_PHONE=5586999999999
HUMAN_ALLOW_CLIENT_RESUME=true
MESSAGE_DEBOUNCE_MS=2500

# Chatwoot CRM Bridge
CHATWOOT_LIA_URL=http://chatwoot-lia:4000
```

> [!WARNING]
> Nunca versione arquivos `.env`, chaves de API ou dados de clientes no Git. Siga rigorosamente as diretrizes em `AGENTS.md`.

---

## 🚀 Deploy e Execução

### Execução Local para Desenvolvimento

```bash
# Instalar / Validar sintaxe
npm run build

# Executar suíte de testes unitários
npm test

# Iniciar servidor de desenvolvimento
npm run dev
```

### Deploy em Produção (Docker)

O projeto está preparado para deploy com Docker Compose na VPS:

```bash
# Construir e subir contêineres em segundo plano
docker compose up -d --build

# Verificar logs em tempo real
docker compose logs -f lia-bot

# Checagem de integridade (Health Check)
curl http://127.0.0.1:3000/health
```

---

## 🔒 Governança e Boas Práticas

- **Atualizações Sem Queda (Zero-Downtime):** Mudanças no webhook exigem verificação prévia de integridade via `/health` e procedimento documentado de rollback.
- **Tratamento de Contatos `@lid`:** O bot preserva identificadores `@lid` quando a Evolution API não resolve o número telefônico correspondente, impedindo erros de entrega.
- **Monitoramento Contínuo:** Circuit breakers automáticos abrem caso o provedor de IA retorne consecutivamente erros de limite (HTTP 429) ou indisponibilidade (HTTP 5xx), chaveando para os modelos de contingência.

---

<div align="center">
  <sub>Desenvolvido com excelência técnica pela equipe de tecnologia da <b>Atualyze</b>.</sub>
</div>
