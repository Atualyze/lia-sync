# Revisão Pix/Lia Sync — notas técnicas

Data da revisão: 2026-11-23

## Fontes
- Repositório: https://github.com/Atualyze/lia-sync
- InfinitePay checkout: https://app.infinitepay.io/external-checkout#checkouts
- Documentação InfinitePay enviada pelo usuário (arquivo local em /home/ubuntu/upload/pasted_content_JCYJeq8nH1xFAlrMttWuNF.txt)
- Supabase project_id: axnlikdgfahbxhatsmiz (lia-sync)

## Evidências
- Banco public.bot_config_state, revisão 118: ferramenta gerenciar_cobranca_pagamento habilitada; handle configurado; API key presente (não registrar valor); pixKeyType telefone; merchantName Tauan Pires; merchantCity Sobral; publicBaseUrl https://liasync.atualyze.com.br; paymentBaseUrl https://pay.atualyze.com.br; redirectUrl https://liasync.atualyze.com.br; payment_page_enabled true; webhookSecret ausente.
- Nenhum evento de webhook com event_type contendo infinite, payment ou pix encontrado em public.webhook_events.
- Código src/http/router.mjs: rotas /api/dashboard/* passam por auth(req, config) e retornam dashboard_auth_required se não houver sessão/autorização.
- Código src/tools/gerenciar_cobranca_pagamento.mjs: InfinitePayOrderStore persiste em data/infinitepay-orders.json; checkout envia /links, order_nsu, webhook_url e redirect_url; gera Pix EMV e portal /pix; não persiste pedidos no Supabase.
- Código src/http/infinitepay-webhook.mjs: callback exige Bearer secret; sem secret sempre retorna 401; valida pagamento por payment_check.
- Documentação InfinitePay fornecida: POST /links, items com price em centavos, order_nsu, redirect_url, payment_check, webhook_url; options.payment_methods_enabled pode incluir pix.
- Painel InfinitePay não foi autenticado: navegador exibiu QR Code e depois “Your QR Code has expired”.
- Testes não completaram no clone porque dependências não estavam instaladas (qrcode, pdf-lib e outras); não alterar projeto só para instalar sem autorização.
