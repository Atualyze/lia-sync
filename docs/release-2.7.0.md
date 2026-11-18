# Release 2.7.0 — Portal Atualyze Pay

## Objetivo

Unificar a experiência de pagamento enviada pela Lia em uma página responsiva: QR Code Pix, chave Pix, código Pix e Cola e checkout InfinitePay ficam disponíveis em um único link.

## Entrega

- A rota pública `/pix` foi redesenhada com a marca Atualyze Pay e layout adaptável para desktop, tablet e mobile.
- A raiz de `pay.atualyze.com.br` usa a chave Pix configurada para mostrar QR Code, cópia da chave e Pix Copia e Cola sem valor fixo; o checkout aparece somente em cobranças com valor e URL oficial válida.
- Os demais subdomínios mantêm a autenticação do dashboard.
- O card de pagamento mostra favorecido, valor, descrição e QR Code.
- O cliente pode copiar o código Pix, copiar a chave Pix ou abrir o checkout InfinitePay em uma nova aba.
- O botão InfinitePay é exibido somente quando o link possui domínio HTTPS permitido.
- `checkout_infinitepay` retorna `paymentUrl` com o payload Pix e o checkout oficial quando a chave Pix está configurada.
- `gerar_cobranca_pix` aceita `paymentBaseUrl`/`PAYMENT_BASE_URL`; o fallback da página é `https://pay.atualyze.com.br`.

## Configuração de domínio

O DNS de `pay.atualyze.com.br` deve apontar para o IP público da VPS. Depois da propagação, é necessário emitir um certificado HTTPS para o subdomínio no Nginx. Até essa etapa, a aplicação pode ser validada pela rota `/pix` do domínio atual e os links continuarão respeitando `publicBaseUrl` quando essa configuração estiver definida.

## Validação

- `node --test src/pix-page.test.mjs src/new-integrations.test.mjs src/schedule-flow-regressions.test.mjs`
- `npm run lint`
- `git diff --check`

A release não altera chaves, tokens ou dados persistentes dos clientes.
