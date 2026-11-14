# Console Operacional Lia Sync (`public/`)

Versão do motor e interface: **2.4.0**. A arquitetura completa do backend está descrita em [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

Acesse em `/dashboard` (ex.: `https://liasync.atualyze.com.br/dashboard`). O console opera como um **Web App reativo 100% integrado**, servido pelo próprio processo da Lia Sync com autenticação Supabase JWT + Turnstile e controle de acesso por papéis (`admin`, `operator`, `viewer`).

---

## ✨ Recursos do Console App v2.4.0

1. **Zero Dados Fixos / 100% Tempo Real:**
   - O cartão lateral de conexão reflete o estado real da instância **Evolution API** (status, nome da instância, latência em ms e janela de expediente ativa).
   - O rodapé da barra lateral exibe o nome, e-mail e papel (`Administrador`, `Operador` ou `Visualizador`) do usuário autenticado no Supabase.
   - As sondas de `web_search` e `calendar` em `/api/dashboard/health-summary` verificam as credenciais e flags reais publicadas.
2. **Configurações com Menus Recolhíveis (Accordions) & Controle Total:**
   - **11 seções recolhíveis (`<details class="config-accordion">`)** com filtro de busca instantânea (`#admin-search-filter`), chips de salto rápido, botões `Expandir tudo` / `Recolher tudo` e indicadores visuais por seção (`Sincronizado` vs `Modificado no rascunho`).
   - Controle integral de todos os parâmetros do runtime:
     - **Identidade, Persona & System Prompt (`ai.systemInstruction`)**
     - **Motor de IA, Roteador de Capacidades (`ai.autoRouting`), Tokens (`ai.maxOutputTokens`) & 3 Modelos Reserva**
     - **Motor de Voz Gemini TTS WAV (`voice.voiceName`, `voice.tone`, `voice.speed`, `voice.autoVoiceOnAudio`, `voice.requestTimeoutMs`)**
     - **Operações, Automação Multimodal, Follow-up & Alertas Humanos**
     - **Janela de Atendimento & Expediente Comercial**
     - **Integração Google Calendar (`workdayStart`, `workdayEnd`, `slotDurationMinutes`, `defaultEventDurationMinutes`)**
     - **Segurança, Guardrails (`safety.protected`, `emergencyMessage`, `blockedMessage`, `fallbackMessage`)**
     - **Mensagens-Base & Roteiros**
     - **Base de Conhecimento (FAQ Dinâmico)**
     - **Histórico de Revisões & Rollback em 1 clique (`/api/admin/config/rollback`)**
3. **Barra Global Reativa de Rascunho & Command Palette (`Ctrl+K`):**
   - Sempre que houver alterações não publicadas no rascunho, uma pílula reativa aparece no topo permitindo publicar de qualquer aba.
   - Atalho global `Ctrl+K` (ou botão `Ir para…`) abre a paleta de comandos para saltar imediatamente para qualquer tela ou seção de configuração.
4. **Capacidades & Simulador ao Vivo do Roteador (`#agent-view`):**
   - Exibe a matriz real `MODEL_CAPABILITIES` (`src/model-router.mjs`) e permite digitar qualquer frase/comando para inspecionar em tempo real quais capacidades (`fast_chat`, `tools`, `web_search`, `document_context`, `deep_reasoning`) e qual modelo + `thinkingBudget` o motor seleciona.
5. **Inbox em 3 Colunas & Layout 100% Responsivo (Desktop, Tablet & Mobile):**
   - **Desktop:** Lista de conversas com abas (`Todas`, `Lia IA`, `Humano`) + Chat ao vivo + Painel lateral de Contexto & Memória (exibindo dados extraídos de CRM e o último documento/PDF analisado na sessão).
   - **Mobile (`<= 768px`):** Navegação Master-Detail nas conversas, menu lateral deslizante com backdrop e barra de navegação inferior estilo app nativo (`mobile-bottom-nav`).
