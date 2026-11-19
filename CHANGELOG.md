# Changelog

## 2.8.0 - Continuidade natural do Copiloto e revisão semântica de tarefas
- **Contexto ativo:** o Copiloto mantém o pedido original, a última pergunta, o tipo da tarefa, os turnos e as ferramentas permitidas enquanto uma solicitação ainda está em andamento.
- **Continuidade sem palavras-chave:** respostas curtas, reformulações, correções e mudanças parciais de assunto são avaliadas pelo contexto, não apenas por correspondência literal de palavras.
- **Revisão de tool calls:** `src/flow/copilot-continuity.mjs` classifica chamadas como continuação, novo pedido, esclarecimento ou assunto não relacionado antes da execução.
- **Esclarecimentos:** perguntas como “não entendi”, “pode explicar?” e “como assim?” preservam a tarefa e não disparam cobrança, envio, agenda ou documento por engano.
- **Áudio do responsável:** o chat interno tenta transcrever áudio antes de interpretar comandos; quando não há transcrição confiável, solicita reenvio ou resumo e não executa ações.
- **Persistência e isolamento:** `pendingCopilotTask` aceita o contexto geral e `allowedTools`, com normalização, limite de itens e expiração; a base de autoconhecimento continua exclusiva do Copiloto.
- **Validação:** 350 testes automatizados aprovados, com lint, build, contratos e publicação Docker validados no commit de release.

## 2.7.0 - Portal Atualyze Pay e pagamento unificado
- **Portal público responsivo:** a rota `/pix` ganhou o layout Atualyze Pay, otimizado para desktop e mobile, com QR Code e hierarquia clara de pagamento.
- **Pix:** botões para copiar chave Pix e código Pix e Cola com feedback visual; a chave é extraída do BR Code quando necessário.
- **InfinitePay:** o checkout passa a retornar `paymentUrl` unificado com Pix e botão para abrir o checkout oficial, preservando `checkoutUrl` para compatibilidade.
- **Segurança:** links InfinitePay aceitos na página são limitados a `https://checkout.infinitepay.io/` e `https://infinitepay.io/`; nenhum segredo é enviado ao navegador.
- **Validação:** testes dedicados cobrem renderização, QR Code, cópia da chave, copia e cola, checkout e payload inválido.

## 2.6.1 - Agenda e retornos com resposta garantida
- **Agenda no atendimento ao cliente:** `gerenciar_agenda_google` passou a ser permitido no fluxo de cliente quando a integração está habilitada, mantendo a validação de configuração e credenciais.
- **Respostas de ferramentas:** o fluxo de cliente transforma resultados de consulta, criação, ausência de horários e falhas da agenda em mensagens explícitas; a Lia não envia apenas uma promessa de consulta.
- **Falhas seguras:** erros de agenda e persistência de lembretes acionam handoff e não confirmam operações não concluídas.
- **Regressões:** adicionados testes para permissão da agenda no cliente, retorno de horários mockados e resposta de falha sem promessa pendente.
- **Operação:** documentação atualizada com o serviço Compose `bot`/contêiner `lia-bot` e a permissão necessária do volume persistente `data/`.

## 2.6.0 - Conhecimento contextual e conversa natural
- **Contexto de conhecimento:** recuperação de trechos relevantes da base vinculada por assunto, com orientação para usar o conteúdo como repertório e não como texto pronto.
- **Memória conversacional:** persistência estruturada de objetivo, necessidade, próximo passo e confirmações para melhorar referências curtas e continuidade.
- **Isolamento e ferramentas:** clientes sem base vinculada não recebem dossiês de outros clientes e não podem alterar CRM diretamente.
- **WhatsApp:** formatação adaptativa preserva negrito, bullets e parágrafos úteis, remove travessão longo e reduz respostas engessadas.
- **Validação:** regressões de conhecimento, segurança de escopo, naturalidade e formatação.

## 2.5.2 — Correção do estado inicial de autenticação
- **Dashboard sem flash pré-login:** shell protegido e navegação inferior mobile começam ocultos até `getSession()` resolver; login, logout e expiração sincronizam visibilidade e `aria-hidden` para desktop e mobile.
- **Validação:** adicionados testes de regressão para o estado inicial e as transições de autenticação.

## 2.5.1 — Hardening de prospecção, privacidade e confiabilidade
- **Hardening de prospecção e privacidade:** RLS e privilégios service-role-only nas tabelas de leads, opt-out contextual para não interceptar clientes ativos, confirmação enviada antes da supressão, claims órfãos recuperáveis, retries com backoff, pausa entre envios, trava contra ticks concorrentes, fila com janela de varredura, contagem paginada no fuso local, cadências por etapas e persistência pós-envio que não transforma sucesso em falha.
- **Retenção e observabilidade:** guards passaram a consultar sessões sem criá-las, templates não inventam nomes vazios, logs usam telefone mais fortemente mascarado, a formatação de atividade respeita o fuso configurado e o schema consolidado acompanha a migration de prospecção.

## 2.5.0 — API pública v1, autoatendimento de integrações, RAG leve nas bases e White-Label 100%


- **API Pública (`/api/v1/*`) e Painel de Integrações (`src/http/api-v1.mjs`, `src/http/integrations-store.mjs`, `src/http/admin.mjs`):** autoatendimento na aba **Integrações** para gerar/revogar Chaves de API (`lia_live_...` com escopos `read`, `write`, `ai`), gerenciar Webhooks de Saída (`message.received`, `handoff.triggered`, `lead.updated` assinados com HMAC-SHA256 e proteção SSRF) e consultar guia n8n.
- **Busca inteligente nas bases de conhecimento (`src/knowledge-bases.mjs`, `src/knowledge.mjs`, `src/tools/consultar_base_conhecimento.mjs`):** leitura recursiva de subpastas (`autoconhecimento/`, `suporte_tecnico/`, `sales_intelligence/`, `biblioteca_juridica/`), ignorando `README.md`, com pontuação por título, subtítulos `##` e corpo do texto e extração apenas das seções relevantes.
- **Reativação com checagem de vácuo e síntese do Copiloto (`src/http/reactivation-notice.mjs`, `src/flow/reactivation-reply.mjs`, `src/flow/owner.mjs`):** ao reativar a IA (`human -> bot`), avalia se o cliente ficou sem resposta e pergunta no chat interno, executando automaticamente a decisão do responsável (manter humano, concluir ou responder ao cliente); síntese genérica `[TOOL_RESULTS_JSON]` para todas as ferramentas do Copiloto.
- **Presença WhatsApp antecipada e descarte de rascunho (`src/whatsapp.mjs`, `src/server.mjs`, `src/admin-config.mjs`):** envio antecipado não-bloqueante de `composing`/`recording` antes da IA responder, redução de atrasos artificiais e rota `POST /api/admin/config/discard` ligada ao botão **Cancelar** da barra flutuante.
- **White-Label 100% (`src/core/identity.mjs`, `src/core/messages.mjs`, `public/app.js`):** remoção de referências pessoais fixas no código, adoção da chave neutra `owner_self` e textos/áudios gerados integralmente a partir da identidade publicada no painel.
- **Validação:** `267` testes automatizados, `26` contratos de arquitetura e `137` módulos verificados.

## 2.4.0 — roteamento por capacidades, tool calling estruturado, voz WAV e visão multimodal

- **Roteamento orientado a capacidades (`src/model-router.mjs`):** adicionados `MODEL_CAPABILITIES` e `detectarCapacidadesExigidas` (`fast_chat`, `tools`, `web_search`, `document_context`, `deep_reasoning`), impedindo que comandos curtos com ferramentas ou busca web caiam no tier `lite` e ajustando `thinkingBudget` dinamicamente (`0` para `lite`/`flash`, `1024` para `pro`).
- **Tool calling estruturado e fallback multi-modelo (`src/ai/call.mjs`, `src/ai/parsing.mjs`):** propriedades completas em `responseSchema.properties.tool_calls.items.properties.args`, compatibilidade com Gemini `v1beta` Structured Outputs, correção do loop de `fallbackModels` no OpenRouter e downgrade gracioso quando um modelo `:free` não suporta `tools` nativo.
- **Leitura multimodal de PDFs e fotos com memória na sessão (`src/ai/documents.mjs`, `src/flow/owner.mjs`, `src/flow/client.mjs`, `src/http/bridge-routes.mjs`):** payload da ponte ampliado para 15 MB, fallback para `gemini-2.5-flash`, persistência de `lastAnalyzedDocument` na sessão e visão multimodal ativa para imagens enviadas por clientes.
- **Voz TTS com cabeçalho RIFF/WAV (`src/ai/voice.mjs`):** `pcm16ToWavBase64` encapsula o áudio PCM `audio/L16` (24 kHz) do Gemini TTS em container WAV válido; removido `speakingRate` inválido do `voiceConfig` no `v1beta`.
- **Google Calendar e Pesquisa Web (`src/tools/gerenciar_agenda_google.mjs`, `src/ai/search.mjs`):** suporte a OAuth2 Refresh Token e Service Account JWT, endpoint `/freeBusy` corrigido, parser de datas (`hoje`, `amanhã`, `DD/MM/YYYY`, `YYYY-MM-DD`) em `America/Sao_Paulo` e busca web via `gemini-2.5-flash`.
- **Projeções e sessões (`supabase/migrations/20261114072000_runtime_projections.sql`, `src/supabase-runtime.mjs`):** `SectorProjection` isolado em `public.runtime_projections` e proteção de sessões locais sujas/limpas em `syncSession`.
- **Validação:** 218 testes automatizados, 26 contratos de arquitetura e build de 108 módulos aprovados.

## 2.3.2 — runtime configurável e execução confiável

- Tool calling e modo Super Agente passam a ter defaults operacionais e continuam derivados pelo painel.
- Memória do cliente e do Copiloto ganhou contexto enviado à IA e retenção máxima configuráveis.
- Google Calendar passou a consumir fuso, ativação e duração de evento da configuração publicada e falha sem credenciais sem inventar horários.
- Corrigida a classificação de propostas, orçamentos, recibos e declarações solicitados na forma “tipo em PDF”.
- Timeout e velocidade de voz passam a ser lidos do painel; transcrição e síntese têm timeout controlado.
- Adicionados testes de persistência do painel, agenda fail-closed e novos parâmetros de runtime.

## 2.3.1 — expediente central no painel e setores fora da configuração publicada

- **Janela de atendimento no painel:** `business.hoursConfig` passou a ser administrado no Lia Sync (ativação, dias, início, fim, fuso, retomada automática e aviso de fora do expediente) usando os fluxos existentes de rascunho, validação e publicação.
- **Validação fail-closed:** só publica com horas na forma HH:MM, fim depois do início, fuso IANA válido, dias entre 0 e 6 sem repetição e aviso de até 2000 caracteres. Uma janela incoerente é rejeitada antes de virar revisão; o motor continua fail-open em tempo de execução.
- **Expediente lido somente leitura pelo Chatwoot:** `GET /api/bridge/v1/config` acrescenta `settings.business.hours` com `isOpenNow`, `nextOpenAt` e `summary` derivados pelo próprio Lia Sync, para o consumidor não replicar a regra. A mudança é aditiva e a `contractVersion` permanece 1. O texto do aviso ao cliente não é exposto.
- **Setores voltam a ser dados do Chatwoot:** `PUT/GET /api/bridge/v1/sectors` mantém projeção de runtime em arquivo próprio (máximo 100 itens e apenas `id`, `name`, `description`, `isActive`); telefones e campos administrativos são descartados. Nenhum fluxo externo publica rascunho ou revisão do painel.
- **Integrações e diagnóstico:** a tela passa a mostrar o expediente efetivo e o estado da projeção de setores; o formulário administrativo exibe a prévia publicada e a pendente de publicação, calculadas no servidor.
- **Validação:** 190 testes, 26 contratos de arquitetura e build de 98 módulos aprovados. Nenhuma migration foi criada ou executada.

## 2.3.0 — confiabilidade distribuída e operação de IA

- **Catálogo de modelos:** consulta server-side a Gemini, OpenRouter, Qwen e OpenAI com credencial configurada; modelo principal e até três fallbacks publicados pelo painel.
- **Orçamento por modelo/provedor:** limites mensais usam reserva atômica distribuída, liquidação pelo modelo efetivamente usado e tratamento conservador de uso/tarifa desconhecidos.
- **Follow-up idempotente:** claim, confirmação e liberação atômicas no Supabase impedem envios concorrentes; sem claim confirmada, não há envio.
- **Webhooks e mídia:** chaves derivadas sanitizadas melhoram deduplicação de eventos sem ID estável; áudio não é repetido automaticamente quando o resultado da entrega é ambíguo.
- **Motor e painel:** reforços em tool calling configurável, falhas de provedor, timeout/persistência Supabase, ferramentas e regressões de envio.
- **Banco:** adicionadas e aplicadas/verificadas no Supabase conectado as migrations `20261113152048_follow_up_atomic_claim.sql`, `20261113153840_atomic_ai_budgets.sql` e `20261113154223_ai_budget_effective_model.sql`; RPCs restritas a `service_role`.
- **Escopo:** expansão de busca semântica/conhecimento do item 4 permanece adiada, fora desta release.
- **Validação:** suíte completa, build, contratos e `git diff --check` aprovados.

## 2.2.8 — Diagnóstico correto de token ausente

- Corrigida a mensagem do guard local: ausência de token não é mais apresentada como erro retornado pelo Supabase.
- Quando o widget ainda não validou, o painel informa diretamente `Conclua a validação CAPTCHA antes de entrar.`

## 2.2.7 — Renderização direta após `api.js` onload

- Removido completamente o uso de `turnstile.ready()` no carregamento dinâmico.
- O widget agora é renderizado diretamente após o evento `onload` do `api.js`, eliminando o conflito com scripts dinamicamente assíncronos.

## 2.2.6 — Carregamento compatível com `turnstile.ready()`

- Removidos `async` e `defer` do script dinâmico `api.js`, conforme exigido pelo Turnstile ao usar `turnstile.ready()`.

## 2.2.5 — Renderização oficial do Turnstile em SPA

- A renderização explícita agora aguarda `turnstile.ready()` conforme a documentação da Cloudflare.
- O envio consulta `turnstile.getResponse(widgetId)` e bloqueia o Supabase quando não existe token válido.
- O widget recebe a ação `login` para separar a métrica de autenticação.

## 2.2.4 — CSP compatível com Turnstile

- Ampliada a CSP do dashboard para os subdomínios dinâmicos de desafio Cloudflare e os canais `data:` usados pelo Turnstile.
- Mantidos os limites de `script-src`, `frame-src`, `img-src` e `connect-src` restritos aos provedores necessários.

## 2.2.3 — Correção de renderização do Turnstile

- Corrigida a inicialização do Turnstile para renderizar o widget somente após a tela de login ficar visível.
- O login agora impede o envio quando o widget não emitiu um token CAPTCHA.

## 2.2.2 — Widget Turnstile compartilhado

- Documentada a integração do widget Turnstile existente no dashboard.
- O login usa a site key pública do ambiente e envia `captcha_token` ao Supabase, mantendo a validação server-side no provedor.
- Documentados os hostnames de produção compartilhados entre Lia Sync e Chatwoot Lia.

## 2.2.1 — Consulta web resiliente

- Corrigido o retorno `INVALID_QUERY` quando o modelo emite `consultar_web` sem o argumento `query`.
- O executor usa a mensagem original do cliente/responsável como fallback, mantendo a validação de tamanho e rejeitando consultas realmente vazias.
- Adicionados testes de fluxo client/owner e regressão da ferramenta.
- Validação: build e 6 testes focados aprovados.

## 2.2.0 — Operação centralizada, campanhas e readiness

- Adicionada a visão autenticada **Saúde & Operação** ao dashboard, com readiness, dependências, modelos, circuit breakers, tokens, incidentes, campanhas, fila e supressões.
- Consolidado o `lia-sync` como fonte de verdade para configurações, ferramentas, campanhas, opt-out e métricas; o Chatwoot Lia permanece como ponte/console.
- Adicionadas rotas autenticadas de resumo operacional, com custos explicitamente estimados quando não há tabela de preços confiável e telefones sempre mascarados.
- Adicionadas migrações de campanhas/idempotência e supressões canônicas com RLS e bloqueio de envio para destinatários suprimidos.
- Incluídos contratos e documentação de deploy, readiness, rollback e teste seguro sem envio WhatsApp por padrão.
- Validação da release: 126 testes, build de 77 módulos e checks de contrato aprovados.

## 2.1.0 — Arquitetura modular e operação configurável

- **Build multiplataforma:** `npm run build` e `npm run lint` deixaram de depender de `find` e `xargs`; ambos usam `scripts/check-syntax.mjs`, compatível com Windows, Linux e macOS.
- **Fluxo modular:** `flow.mjs` virou uma fachada e o atendimento foi separado em `flow/client.mjs`, `flow/owner.mjs`, `flow/text.mjs`, `flow/media.mjs` e `flow/pdf.mjs`.
- **IA e HTTP modularizados:** implementações foram extraídas para `src/ai/` e `src/http/`, com as fachadas públicas preservadas para evitar quebra de imports.
- **Identidade configurável:** responsável, empresa, apelidos e telefone humano são resolvidos a partir da configuração publicada no painel. Identificadores e mensagens antigos continuam apenas como compatibilidade de dados existentes.
- **Mídia:** PDFs criados pelo Copiloto passam a ser enviados como documento; voz é entregue sem legenda redundante.
- **Documentação:** README, guia de arquitetura e documentação do dashboard atualizados para a estrutura 2.1.0.

## 2.0.1 — Auditoria de Segurança, Guardrails Clínicos e 100% de Testes Aprovados
- **98 testes automatizados aprovados (100% de cobertura):** resolução de divergências de asserções em `corrections.test.mjs`, `human-mode.test.mjs`, `maintenance.test.mjs`.
- **Limpeza de credenciais hardcoded:** remoção definitiva de scripts legados e temporários da raiz e de `scripts/` (`test_audio.py`, `check_db.py`, `check_remote.py`, `check_remote_phone.py`, `deploy_remote.py`).
- **Segurança e Guardrails (`safety.mjs`):**
  - Adicionada detecção de negação e passado distante em `isEmergency` (evita falsos positivos como "ele não teve convulsão" ou "atropelado há 3 anos").
  - Refinamento de `isClinicalConcern` com suporte a variações morfológicas (`vomit*`, `diarreia*`) e bloqueio de falsos positivos (cocker, ao redor, etc.).
  - Restauração de bloqueio estrito de prescrições médicas/veterinárias e remédios caseiros em `filterReply`.
- **Fluxo e Retomada (`flow.mjs`):**
  - Exportação de `collectedValid` e `isHumanRequest`.
  - Harmonização de respostas determinísticas de retomada (`bot`) e urgência (`pronto-socorro`).
  - Fallback de IA com notificação horária ao operador humano em instabilidades.
- **Manutenção e Inatividade (`maintenance.mjs`):**
  - Harmonização do estágio 1 de inatividade com respeito a pings e lembretes.

- **401 correto:** reservado para token ausente ou inválido.
- **403 correto:** perfil Supabase inexistente, inativo ou fora dos papéis permitidos agora retorna `403`, sem apagar a sessão do navegador.
- **503 correto:** indisponibilidade temporária do Supabase não é tratada como logout.
- **Diagnóstico:** dashboard informa quando o usuário autenticou, mas ainda não tem um registro ativo em `public.profiles`.

## 0.5.3 — renovação resiliente da sessão do dashboard
- **Renovação automática:** a sessão Supabase é sincronizada antes das chamadas protegidas e periodicamente durante a navegação.
- **Retry de autenticação:** um `401` tenta renovar o token e repetir a requisição antes de encerrar a sessão.
- **Falhas transitórias:** problemas temporários de rede durante o refresh não apagam imediatamente a sessão armazenada no navegador.
- **Diagnóstico:** o logoff só ocorre após uma segunda resposta `401`, evitando saídas causadas por uma atualização isolada.

## 0.5.2 — correção de login CAPTCHA do Supabase
- **CAPTCHA no login:** adicionado suporte opcional a Cloudflare Turnstile e hCaptcha, com envio de `captcha_token` ao Supabase.
- **Configuração:** adicionadas `SUPABASE_CAPTCHA_PROVIDER` e `SUPABASE_CAPTCHA_SITE_KEY` ao `.env.example`.
- **Diagnóstico:** o dashboard exibe uma mensagem orientando a configurar o widget ou desativar a proteção quando o Supabase retornar `no captcha_token found`.
- **Segurança:** CSP atualizada para permitir somente os domínios necessários do widget CAPTCHA.

## 0.5.1 — seleção publicada de IA e atendimento humano
- **Configuração fora do `.env`:** removidos `AI_PROVIDER`, modelos, fallbacks e `HUMAN_PHONE` das configurações de ambiente de exemplo.
- **Runtime orientado pelo dashboard:** o provedor, modelo, fallbacks, parâmetros de saída e telefone humano agora são lidos do snapshot publicado da configuração administrativa.
- **Fail-closed de IA:** sem provedor e modelo publicados, o bot não escolhe defaults silenciosos; informa a ausência de publicação e usa o fallback seguro do fluxo.
- **Handoff dinâmico:** alterações publicadas no telefone humano passam a valer para notificações, lembretes e o comando `bot <telefone>` sem reiniciar a aplicação.
- **Dashboard:** adicionados campos para provedor, modelo, fallbacks, telefone e habilitação do atendimento humano, com validação de telefone e publicação versionada.
- **Documentação:** README, `.env.example` e changelog alinhados ao fluxo de configuração publicada e ao schema Supabase preparado.
- **Validação:** build e 39 testes automatizados aprovados.


## 0.5.0 — Supabase próprio e autenticação resiliente

- **Banco independente do bot:** adicionadas migrações Supabase para autenticação, perfis, planos, FAQ, preferências, contatos, pets, conversas, mensagens, handoffs, eventos, configuração versionada, métricas de IA e auditoria.
- **RLS e integridade:** incluídos índices, foreign keys, constraints, timestamps automáticos e políticas de leitura separando conteúdo público, dashboard e dados operacionais.
- **Seed seguro:** criado `supabase/seed.sql` com dados de teste e planos inativos por padrão, evitando publicação acidental de preços fictícios.
- **Cliente Supabase:** login agora trata falhas de rede, timeout, CORS, respostas não-JSON, sessão corrompida e renovação por `refresh_token`.
- **Dashboard:** mensagens de erro de autenticação passaram a exibir detalhes úteis sem expor credenciais.
- **Migrações reaplicáveis:** triggers e policies usam `drop ... if exists` antes da recriação para evitar erros ao reexecutar no SQL Editor.
- **Documentação:** README principal e documentação do Supabase atualizados para o fluxo de staging independente.

## 0.4.0 — painel administrativo e preview seguro

- **Painel administrativo:** adicionada área de administração para editar identidade, contexto comercial, tom de voz, mensagens-base, comportamento operacional e FAQ sem alterar o código.
- **Configuração dinâmica:** criado `AdminConfigStore` com snapshot ativo, rascunho, autosave, publicação versionada, histórico e rollback.
- **Preview isolado:** novo `POST /api/admin/config/preview` executa mensagens usando o rascunho atual em uma sessão temporária, sem enviar WhatsApp, persistir conversa real ou disparar handoff.
- **Contexto publicado no runtime:** o fluxo, o system prompt e a FAQ passam a consumir a configuração publicada, mantendo os guardrails clínicos essenciais no código.
- **Diagnóstico de IA:** o dashboard identifica provedores sem credencial antes do ping e deixa de reportar ausência de chave como “Resposta vazia”.
- **Documentação:** README atualizado com operação local, APIs administrativas, preview e configuração de provedores.

## 0.3.4 — correções críticas e resiliência

- **C2 (Resposta vazia e JSON truncado)**: O parser recupera o texto de `reply` mesmo em payloads JSON truncados ou incompletos (`extractTruncatedReply`). Respostas vazias ou falhas de modelo nunca retornam string vazia para o cliente, caindo com segurança para mensagem amigável ou FAQ.
- **C3 (Quebra do loop de emergência)**: O comando `bot` reseta o contador de `symptomTurns` e a janela de triagem. Consultas subsequentes sobre outros assuntos (ex.: planos) não reativam inadvertidamente o texto de emergência.
- **C4 (Handoff e modo humano)**: `triggerHandoff` notifica a Dra. novamente em casos de emergência real. Relato de emergência ("foi atropelado") recebido enquanto a sessão já está em modo humano agora envia prontamente a orientação de pronto-socorro 24h e re-notifica com urgência.
- **C5 (Prevenção de corrida em `fromMe`)**: Registro prévio das mensagens enviadas pelo bot (`recordBotSend`) e janela de carência para resolução do ID de envio da Evolution impedem que o bot tome posse de si mesmo (`humanSource: takeover`).
- **A1 (Sintoma com IA indisponível)**: Quando a IA está indisponível e o cliente relata sintomas por mais de um turno, o bot aciona handoff com aviso claro em vez de repetir a mesma pergunta em looping.
- **A2 (Sanitização de anotações internas)**: Remoção de `// CONFIRMAR COM A DRA.` dos itens de FAQ e sanitização em `filterReply` para impedir vazamento de comentários internos para o cliente.
- **A3 & A4 (Ordem dos provedores e Circuit Breaker)**: Provedores saudáveis têm prioridade sobre provedores em quarentena. Erros de quota (`429`) e autenticação abrem quarentena imediatamente, e chamadas bem-sucedidas limpam a quarentena.
- **Correções de segurança e regex**:
  - `safety.mjs`: Remoção de `de|dê` dos verbos clínicos para evitar falso positivo com a preposição "de" ("Trabalhamos de manhã com chá e café"). Remoção da cláusula "não precisa (levar|ir)" para permitir o pitch de atendimento domiciliar.
  - `flow.mjs`: Correção da blacklist de `tutorName` com `\bola\b` (preservando nomes reais como Nicolas, Paola, Lola). Validação de evidência textual de `tutorName` garantindo exclusão quando o nome não foi dito pelo cliente.
  - `isHumanRequest`: Adicionada âncora de borda `\b` para evitar falsos positivos ("atendimento pessoal") e remoção de "veterinaria" que causava falso positivo em buscas de serviço. Removida função duplicada morta em `knowledge.mjs`.
  - Fallback Gemini: Adicionado `gemini-2.5-flash-lite`, suporte a erro `503` via `/\b(404|429|5\d\d)\b/`, isolamento de `thinkingConfig` apenas para modelos 2.5, timeout com `AbortSignal` individual por modelo e preservação do erro primário para o circuit breaker.
  - Normalização do 9º dígito: `config.humanPhone` normalizado na comparação de comandos `bot <telefone>`. Criado script `scripts/migrate-phones.mjs`.

## Próxima versão

- Corrigida a retomada persistente: `bot <telefone>` enviado pelo número humano agora é processado antes de `fromMe`, e `bot`/`voltar`/`reativar` do cliente ficam habilitados por padrão.
- Atualizado o modelo OpenRouter gratuito padrão de `google/gemini-2.0-flash-exp:free` para `google/gemma-4-31b-it:free`, evitando falha `404` por modelo removido.
- Adicionados Structured Outputs com JSON Schema estrito, `provider.require_parameters`, fallback de modelos e detalhes de erro sanitizados para o OpenRouter.
- Tornado o Structured Outputs estrito opcional: endpoints gratuitos usam JSON básico por padrão para evitar `404 No endpoints found` quando não suportam simultaneamente `json_schema` e `require_parameters`.

## 0.2.0 — correção e evolução

A arquitetura foi separada em módulos `src/` sem efeitos colaterais no import. O webhook agora falha fechado sem token, compara autorização com `timingSafeEqual`, aceita apenas `MESSAGES_UPSERT`, ignora grupos/broadcast, limita corpo JSON, sanitiza entradas, deduplica IDs, aplica rate limit, fila por telefone e namespace `sim:`. JIDs `@lid` preservam o JID completo quando não existe número alternativo.

A persistência usa escrita atômica, debounce, fila de salvamento, preservação de JSON corrompido e expurgo TTL. O detector clínico usa palavras inteiras e negação; emergência é determinística. Toda resposta passa por filtro de formato, clínica, preço e afirmações absolutas. A IA tem contrato JSON, parser tolerante, histórico normalizado, timeout, fallback de provider e circuit breaker.

O handoff foi centralizado em `triggerHandoff`, com resumo, urgência e flag de notificação. FAQ remoto/CRM tem precedência sobre a FAQ local, cache compartilhado e preços permitidos. Dashboard usa pathname, valida telefone, separa simulação, autenticação em cache, CORS restrito e cliente Supabase local sem CDN em runtime. Docker, `.env.example`, `AGENTS.md` e README foram atualizados; `metadata.json` foi removido.

### Decisões e riscos

Quando o requisito conflitou com o servidor anterior, prevaleceu o prompt: atalhos fixos foram removidos do fluxo principal, preços locais não são autorizados e o token de transferência não é armazenado no histórico. O comportamento exato de `fromMe`/`source` e JIDs `@lid` depende de payload real da Evolution v2.3.7. Lembretes de handoff precisam de um worker operacional antes do uso produtivo.

### Pendências do proprietário

Confirmar textos `CONFIRMAR COM A DRA.`, a política de preços somente-CRM, o `HUMAN_PHONE`, a ativação de `HUMAN_AUTO_RESUME_HOURS` e os payloads reais de takeover da Evolution.

## 0.3.0 — segunda rodada

Foram concluídos o debounce/coalescência de mensagens do webhook, aviso único de rate limit, takeover automático por `fromMe`, retomada com política `HUMAN_ALLOW_CLIENT_RESUME`, limitação de triagem a três turnos, lembretes de handoff em 15/60 minutos, manutenção de inatividade, arquivamento real com cópia em `data/archive/`, presença `composing`, orçamento total de IA de 25 segundos, `responseSchema` Gemini e suporte seguro a JIDs `@lid`. O dashboard passou a ter polling de 5 segundos pausável por visibilidade, configuração restaurada e botão de arquivamento.

A suíte passou a cobrir 22 casos automatizados. Permanecem como validação de produção os payloads reais da Evolution e a confirmação dos textos comerciais pela Dra.

## 0.3.1 — fechamento de fluxo

Foi acrescentada a divisão de respostas longas em até três mensagens, fallback sem IA com handoff limitado a uma vez por hora, validação de dados coletados contra evidência textual, registro de `awaitingReply`/`lastBotAt` para manutenção e marcação de falha definitiva de envio.

## 0.3.2 — integração

Foram adicionados hooks de autenticação injetável para testes e cobertura de integração do dashboard, incluindo `simulate?x=1`, validação de telefone em `mode` e proteção de limpeza de conversas reais.

## 0.3.3 — suporte a OpenRouter e modelos gratuitos

Foi adicionado suporte ao provedor OpenRouter (`AI_PROVIDER=openrouter`), permitindo o uso de modelos de IA gratuitos (`google/gemini-2.0-flash-exp:free`, `meta-llama/llama-3.3-70b-instruct:free`, etc.) e pagos com chave unificada. O provedor integra-se nativamente à cadeia de resiliência e circuit breaker com fallback automático entre provedores (`gemini`, `openrouter`, `qwen`, `openai`).
