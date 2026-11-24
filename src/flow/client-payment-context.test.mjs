import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizedClientText,
  amountFromText,
  hasActivePriceContext,
  isUsablePaymentCredential,
  paymentChoiceReply,
  paymentUnavailableReply,
  formatPixKeyForDisplay,
  directPixKeyReply,
  resolveConfiguredPixKey,
  formatPixSuccessReply
} from './client-payment-context.mjs';

test('client payment context: normaliza texto sem acentos e espaços excedentes', () => {
  assert.equal(normalizedClientText('  PREÇO   da mensalidade  '), 'preco da mensalidade');
});

test('client payment context: interpreta valores decimais em formatos brasileiros e internacionais', () => {
  assert.equal(amountFromText('R$ 125,50'), 125.5);
  assert.equal(amountFromText('75.25 reais'), 75.25);
  assert.equal(amountFromText('sem valor informado'), 0);
  assert.equal(amountFromText('R$ 0,00'), 0);
});

test('client payment context: reconhece contexto de preço atual, anterior ou pagamento pendente', () => {
  assert.equal(hasActivePriceContext('Quanto custa o plano?'), true);
  assert.equal(hasActivePriceContext('', [], true), true);
  assert.equal(hasActivePriceContext('Quero contratar', [
    { role: 'user', content: 'Qual é o valor do plano?' },
    { role: 'assistant', content: 'Posso te explicar as opções.' },
    { role: 'user', content: 'Quero contratar' }
  ]), true);
  assert.equal(hasActivePriceContext('Quero contratar', [
    { role: 'user', content: 'Quero conhecer a empresa' }
  ]), false);
});

test('client payment context: rejeita credenciais de exemplo e aceita credencial configurada', () => {
  for (const placeholder of ['', 'suaempresa', 'inserir aqui', 'placeholder', 'changeMe', 'teste']) {
    assert.equal(isUsablePaymentCredential(placeholder), false, placeholder);
  }
  assert.equal(isUsablePaymentCredential('conta_loja_123'), true);
});

test('client payment context: monta a pergunta conforme Pix e checkout disponíveis', () => {
  assert.match(paymentChoiceReply({ hasPix: true, hasCheckout: true }), /chave Pix.*código Pix.*checkout/i);
  assert.match(paymentChoiceReply({ hasPix: true, hasCheckout: false }), /chave Pix.*código Pix/i);
  assert.match(paymentChoiceReply({ hasPix: false, hasCheckout: true }), /link de checkout/i);
  assert.match(paymentChoiceReply({ hasPix: false, hasCheckout: false }), /equipe.*dados de pagamento/i);
});

test('client payment context: explica indisponibilidade sem afirmar que gerou cobrança', () => {
  const none = paymentUnavailableReply();
  assert.match(none, /ainda não gerei o Pix/i);
  assert.match(paymentUnavailableReply({ hasCheckout: true, hasPix: false }), /chave Pix ainda não está configurada/i);
  assert.match(paymentUnavailableReply({ hasCheckout: true, hasPix: true }), /não consegui disponibilizar/i);
});

test('client payment context: normaliza chave telefônica para exibição e configuração', () => {
  assert.equal(formatPixKeyForDisplay('+5511999999999'), '11999999999');
  assert.equal(formatPixKeyForDisplay('loja@exemplo.com'), 'loja@exemplo.com');

  const configured = {
    tools: {
      settings: {
        gerenciar_cobranca_pagamento: {
          pixKey: '11999999999',
          pixKeyType: 'telefone'
        }
      }
    }
  };
  assert.equal(resolveConfiguredPixKey(configured), '+5511999999999');
  assert.equal(resolveConfiguredPixKey({
    tools: { settings: { gerenciar_cobranca_pagamento: { pixKey: 'SUA CHAVE PIX AQUI' } } }
  }), '');
});

test('client payment context: cria resposta direta da chave Pix com favorecido', () => {
  const reply = directPixKeyReply({ key: '+5511999999999', owner: 'Loja Exemplo' });
  assert.match(reply, /11999999999/);
  assert.match(reply, /Loja Exemplo/);
  assert.match(directPixKeyReply({ key: '', owner: 'Loja Exemplo' }), /ainda não está configurada/i);
});

test('client payment context: formata confirmação Pix e respeita a modalidade de pagamento', () => {
  const reply = formatPixSuccessReply({
    valor: 12.5,
    favorecido: 'Loja Exemplo',
    paymentUrl: 'https://pay.example.test/abc',
    paymentMethod: 'checkout',
    pixCopiaECola: '000201'
  }, {
    owner: 'Responsável',
    pixKey: '+5511999999999'
  });

  assert.match(reply, /R\$ 12,50/);
  assert.match(reply, /Loja Exemplo/);
  assert.match(reply, /https:\/\/pay\.example\.test\/abc/);
  assert.match(reply, /000201/);
  assert.doesNotMatch(reply, /Chave Pix:/);
});


test('client payment context: inclui link curto junto do Pix Copia e Cola', () => {
  const reply = formatPixSuccessReply({
    valor: 30,
    favorecido: 'Atualyze',
  assert.match(reply, /https:\/\/pay\.atualyze\.com\.br\/p\/[A-Za-z0-9_-]{16}/);
    paymentMethod: 'pix_copy_paste',
  assert.match(reply, /000201BR\.CODE\.TESTE/);
  }, { owner: 'Responsável' });

  assert.match(reply, /https:\\/\\/pay\\.atualyze\\.com\\.br\\/p\\/[A-Za-z0-9_-]{16}/);
  assert.match(reply, /000201BR\.CODE\.TESTE/);
});
