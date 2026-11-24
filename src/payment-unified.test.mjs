import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPixPaymentPage } from './http/pix-page.mjs';
import { SupabaseInfinitePayOrderStore, toolGerenciarCobrancaPagamento } from './tools/gerenciar_cobranca_pagamento.mjs';
import { ALL_TOOLS, resolveToolName } from './tools/index.mjs';

const botConfig = {
  tools: {
    settings: {
      gerenciar_cobranca_pagamento: {
        pixKey: 'pix@atualyze.com.br',
        merchantName: 'Atualyze',
        merchantCity: 'SAO PAULO',
        paymentBaseUrl: 'https://pay.atualyze.com.br'
      }
    }
  }
};

test('pagamento: catálogo expõe somente a ferramenta unificada', () => {
  assert.equal(ALL_TOOLS.filter(tool => tool.name === 'gerenciar_cobranca_pagamento').length, 1);
  assert.equal(ALL_TOOLS.some(tool => tool.name === 'gerar_cobranca_pix'), false);
  assert.equal(ALL_TOOLS.some(tool => tool.name === 'checkout_infinitepay'), false);
  assert.notEqual(resolveToolName('gerar_cobranca_pix'), 'gerenciar_cobranca_pagamento');
  assert.notEqual(resolveToolName('checkout_infinitepay'), 'gerenciar_cobranca_pagamento');
});

test('pagamento: rejeita valores negativos, zero, subcentavo e inválidos', async () => {
  for (const valor of [-1, 0, 0.004, 'invalido']) {
    const result = await toolGerenciarCobrancaPagamento.execute({ acao: 'criar_pix', valor }, { actor: 'owner', botConfig });
    assert.equal(result.success, false, `valor=${valor}`);
    assert.equal(result.error, 'invalid_amount');
  }
});

test('pagamento Pix retorna link curto e persiste a URL canônica sem alterar o BR Code', async () => {
  let recordedOrder = null;
  const orderStore = { async recordOrder(order) { recordedOrder = order; return order; } };
  const result = await toolGerenciarCobrancaPagamento.execute(
    { acao: 'criar_pix', valor: 30, enviarWhatsApp: false },
    { actor: 'client', botConfig, infinitePayOrders: orderStore }
  );

  assert.equal(result.success, true);
  assert.match(result.paymentUrl, /^https:\/\/pay\.atualyze\.com\.br\/p\/[A-Za-z0-9_-]{16}$/);
  assert.equal(recordedOrder.shortCode, result.paymentUrl.split('/').at(-1));
  const storedUrl = new URL(recordedOrder.paymentUrl);
  assert.equal(storedUrl.pathname, '/pix');
  assert.equal(Buffer.from(storedUrl.searchParams.get('p'), 'base64url').toString('utf8'), result.pixCopiaECola);
  assert.equal(storedUrl.searchParams.get('v'), '30.00');
});

test('Supabase resolve o link curto pela metadata persistida do pedido', async () => {
  const calls = [];
  const shortCode = 'AbCdEf0123456789';
  const client = {
    enabled: true,
    async select(table, query) {
      calls.push({ table, query });
      return [{
        order_nsu: 'LIA123',
        status: 'pending',
        payment_url: 'https://pay.atualyze.com.br/pix?p=YWJj',
        metadata: { actor: 'client', shortCode }
      }];
    }
  };
  const orderStore = new SupabaseInfinitePayOrderStore({ client });
  const order = await orderStore.findByShortCode(shortCode);
  assert.equal(order.orderNsu, 'LIA123');
  assert.equal(order.shortCode, shortCode);
  assert.equal(calls[0].table, 'payment_orders');
  assert.match(calls[0].query, /metadata->>shortCode=eq\.AbCdEf0123456789/);
});

test('pagamento: usa o mesmo valor em centavos no Pix e no retorno', async () => {
  const result = await toolGerenciarCobrancaPagamento.execute({ acao: 'criar_pix', valor: 10.01, enviarWhatsApp: false }, { actor: 'owner', botConfig });
  assert.equal(result.success, true);
  assert.equal(result.amountCents, 1001);
  assert.equal(result.valor, 10.01);
  assert.match(result.pixCopiaECola, /540510\.01/);
});

test('página Pix ignora metadados adulterados e não reflete script executável', async () => {
  let recordedOrder = null;
  const orderStore = { recordOrder(order) { recordedOrder = order; return order; } };
  const result = await toolGerenciarCobrancaPagamento.execute(
    { acao: 'criar_pix', valor: 10, enviarWhatsApp: false },
    { actor: 'owner', botConfig, infinitePayOrders: orderStore }
  );
  const url = new URL(recordedOrder.paymentUrl);
  url.searchParams.set('v', '999.99');
  url.searchParams.set('n', 'Atacante');
  url.searchParams.set('k', 'attacker@example.com');
  let html = '';
  const response = { writeHead() {}, end(value) { html = String(value); } };
  await renderPixPaymentPage(response, url);
  assert.match(html, /R\$ 10,00/);
  assert.doesNotMatch(html, /R\$ 999,99|Atacante|attacker@example\.com/);

  const malicious = new URL(recordedOrder.paymentUrl);
  const payload = Buffer.from(result.pixCopiaECola + '</script><img src=x onerror=alert(1)>').toString('base64url');
  malicious.searchParams.set('p', payload);
  html = '';
  await renderPixPaymentPage(response, malicious);
  assert.doesNotMatch(html, /<\/script><img/i);
});
