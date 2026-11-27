# Release Notes — Lia Sync v3.7.0

## Resumo
A versão **3.7.0** consolida a **Voz Neural Multi-Provedor (Azure AI Speech, Gemini TTS e Azure OpenAI TTS)**, os **Prompts Editáveis de Copiloto e Cliente** com vínculo natural ao administrador, suporte validado ao **Azure OpenAI (`gpt-4.1-mini`)** e melhorias de UX/estabilidade no painel de publicação.

## Principais Entregas
1. **Voz Neural Multi-Provedor (`src/ai/voice.mjs`, `src/config.mjs`, `src/admin-config.mjs`, `src/http/dashboard.mjs`):**
   - Suporte a **Azure AI Speech** (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, vozes `pt-BR-FranciscaNeural`, `pt-BR-ThalitaNeural`, `pt-BR-GiovannaNeural`, `pt-BR-BrendaNeural`, `pt-BR-AntonioNeural`, `pt-BR-DonatoNeural` e tier Free F0 de 500k caracteres/mês).
   - Suporte a **Azure OpenAI TTS** (`AZURE_OPENAI_TTS_ENDPOINT`, `AZURE_OPENAI_TTS_KEY`, `AZURE_OPENAI_TTS_MODEL`, vozes `nova`, `coral`, `sage`, `alloy`, `shimmer`, `onyx`, `ash`, `echo`, `fable`).
   - Aplicação real da **Diretriz Acústica (`voice.tone`)** nos 3 motores (prompt no Gemini, `<mstts:express-as>` no Azure Speech e `instructions` no `gpt-4o-mini-tts`).
   - Endpoint `POST /api/dashboard/tts` aceitando `provider`, `model`, `voiceName` e `tone` para audição imediata no painel antes mesmo de publicar.
2. **Prompts Editáveis & Identidade no Copiloto (`src/knowledge.mjs`, `src/core/personality.mjs`, `src/ai/call.mjs`):**
   - Campos `ai.copilotPrompt` e `ai.clientPrompt` no painel (até 8.000 caracteres cada), completamente isolados entre si.
   - Bloco `[IDENTIDADE_E_VINCULO_COM_ADMIN]` no Copiloto para reconhecer o administrador, apelidos e tom configurado.
   - `appendMasterSystemInstruction` garante precedência das regras estruturais de segurança, privacidade e confirmação.
3. **Painel & Publicação (`public/index.html`, `public/app.js`):**
   - Filtro dinâmico de vozes compatíveis com o provedor selecionado (`updateVoiceOptionsVisibility`).
   - Preservação de vozes Azure/OpenAI em `renderAdmin()`.
   - Extração limpa de `errors[]` em `api()`, tratamento informativo de `noChanges` e contador real de campos alterados (`countLeafDiffs`) no botão **Publicar**.
4. **Comandos & Autoconhecimento (`src/channels/telegram.mjs`, `src/flow/owner-commands.mjs`, `data/knowledge-bases/autoconhecimento/lia-autoconhecimento-operacoes.md`):**
   - Novos comandos `/crm` e `/versao` no Telegram Copiloto.
   - Manual de autoconhecimento e respostas de versão/capacidades atualizados para `v3.7.0`.

## Validação
- `npm run lint` (290 módulos) e `npm run lint:eslint` (`--max-warnings=0`).
- `npm test` (suíte completa).
- `npm run build` e `npm run test:contract`.
