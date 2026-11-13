# Changelog

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
