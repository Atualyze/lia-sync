import test from 'node:test';
import assert from 'node:assert/strict';
import { getSafeInfinitePayCheckoutUrl } from './payment-urls.mjs';
import { createInfinitePayLink, toolGerenciarCobrancaPagamento } from './tools/gerenciar_cobranca_pagamento.mjs';

test('valida checkout InfinitePay por HTTPS e hostname exato', () => {
  assert.equal(getSafeInfinitePayCheckoutUrl('https://checkout.infinitepay.io/atualyze/abc'), 'https://checkout.infinitepay.io/atualyze/abc');
  assert.equal(getSafeInfinitePayCheckoutUrl('https://pay.infinitepay.io/atualyze/abc'), 'https://pay.infinitepay.io/atualyze/abc');
  for (const url of [
    'http://checkout.infinitepay.io/atualyze/abc',
    'https://checkout.infinitepay.io.evil.example/atualyze/abc',
    'https://checkout.infinitepay.io@evil.example/atualyze/abc',
    'https://checkout.infinitepay.io:8443/atualyze/abc',
    'https://infinitepay.io/',
    'javascript:alert(1)',
    ''
  ]) assert.equal(getSafeInfinitePayCheckoutUrl(url), '');
});

test('Pix aceita somente URL InfinitePay permitida no paymentUrl unificado', async () => {
  const result = await toolGerenciarCobrancaPagamento.execute({ acao: 'criar_pix',
    valor: 25,
    chavePix: 'pix-test@atualyze.com.br',
    checkoutUrl: 'https://checkout.infinitepay.io.attacker.example/pay',
    enviarWhatsApp: false
  }, { actor: 'owner', botConfig: { identity: { companyName: 'Atualyze' }, tools: { settings: { gerenciar_cobranca_pagamento: { pixKey: 'pix-test@atualyze.com.br', merchantName: 'Atualyze', merchantCity: 'Fortaleza', paymentBaseUrl: 'https://pay.example.test' } } } } });
  assert.equal(result.success, true);
  const paymentUrl = new URL(result.paymentUrl);
  assert.equal(paymentUrl.pathname, '/pix');
  assert.ok(paymentUrl.searchParams.has('p'));
  assert.equal(paymentUrl.searchParams.get('v'), '25.00');
  assert.equal(paymentUrl.searchParams.has('c'), false);
});

test('Pix de valor livre não carrega checkout InfinitePay mesmo com URL permitida', async () => {
  const result = await toolGerenciarCobrancaPagamento.execute({
    valor: 0,
    valorLivre: true,
    chavePix: 'pix-test@atualyze.com.br',
    checkoutUrl: 'https://checkout.infinitepay.io/atualyze/abc',
    enviarWhatsApp: false
  }, { actor: 'owner', botConfig: { identity: { companyName: 'Atualyze' }, tools: { settings: { gerenciar_cobranca_pagamento: { pixKey: 'pix-test@atualyze.com.br', merchantName: 'Atualyze', merchantCity: 'Fortaleza', paymentBaseUrl: 'https://pay.example.test' } } } } });
  const paymentUrl = new URL(result.paymentUrl);
  assert.equal(paymentUrl.searchParams.has('v'), false);
  assert.equal(paymentUrl.searchParams.has('c'), false);
});

test('checkout InfinitePay mantém paymentUrl mesmo sem chave Pix configurada', async () => {
  const result = await toolGerenciarCobrancaPagamento.execute({ acao: 'criar_checkout', valor: 25, descricao: 'Teste' }, {
    botConfig: { tools: { settings: { gerenciar_cobranca_pagamento: { handle: 'atualyze' } } } },
    infinitePayOrders: { recordOrder() {} },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ url: 'https://checkout.infinitepay.io/atualyze/abc' })
    })
  });
  assert.equal(result.success, true);
  assert.equal(result.paymentUrl, 'https://checkout.infinitepay.io/atualyze/abc');
});

test('API InfinitePay não aceita URL externa retornada pelo checkout', async () => {
  await assert.rejects(() => createInfinitePayLink({
    handle: 'atualyze',
    items: [{ quantity: 1, price: 2500, description: 'Teste' }],
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ url: 'https://checkout.infinitepay.io.evil.example/pay' })
    })
  }), /URL de checkout HTTPS válida/);
});
