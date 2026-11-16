# Release 2.5.0 — API Pública v1, Integrações no Painel, Bases Inteligentes e White-Label 100%

## Resumo das entregas
1. **API Pública (`/api/v1/*`) e Painel de Integrações:**
   - Autenticação por `Bearer` / `x-api-key` com chaves `lia_live_...` geradas e revogadas pelo painel (`IntegrationsStore` persistido em `runtime_projections`).
   - Webhooks de saída (`message.received`, `handoff.triggered`, `lead.updated`) com assinatura `x-lia-signature` (HMAC-SHA256) e proteção SSRF (`isSafeWebhookUrl`).
   - Guia rápido n8n em acordeão na aba **Integrações**.
2. **Bases de Conhecimento Inteligentes:**
   - Organização em subpastas (`autoconhecimento/`, `suporte_tecnico/`, `sales_intelligence/`, `biblioteca_juridica/`) com modelo em `data/knowledge-bases/README.md` (ignorado na indexação).
   - Busca por relevância em título, subtítulos `##` e corpo do texto com extração enxuta das seções mais relevantes.
3. **Fluxo do Copiloto e Reativação:**
   - Checagem de conversa sem resposta (*no vácuo*) na reativação (`human -> bot`), com pergunta no chat interno e execução automática da decisão (manter humano, concluir ou responder ao cliente).
   - Síntese genérica `[TOOL_RESULTS_JSON]` para todas as ferramentas do Copiloto em `src/flow/owner.mjs`.
4. **WhatsApp, Painel e White-Label 100%:**
   - Presença antecipada (`composing` / `recording`) não-bloqueante em `src/server.mjs` e `src/whatsapp.mjs`.
   - Descarte de rascunho via `POST /api/admin/config/discard` no botão **Cancelar** da barra flutuante.
   - Remoção de referências pessoais fixas (`owner_self` neutro, `isOwnerContact`, `isTalkToOwnerRequest` e `isOwner`).

## Validação
- `npm run lint`: `137` módulos verificados.
- `npm run build`: frontend empacotado em `dist/` e `dist/dashboard/`.
- `npm run test:contract`: `26` contratos `PASS`.
- `npm test`: `267/267` testes passando.
