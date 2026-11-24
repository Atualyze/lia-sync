import test from 'node:test';
import assert from 'node:assert/strict';
import { isNaturalAffirmation, isNaturalNegative, resolvePaymentChoice, isPixActionRequest } from './decision-signals.mjs';

test('confirmação: aceita respostas curtas e inequívocas', () => {
  assert.equal(isNaturalAffirmation('sim'), true);
  assert.equal(isNaturalAffirmation('Pode marcar.'), true);
  assert.equal(isNaturalAffirmation('Sim, pode marcar'), true);
  assert.equal(isNaturalAffirmation('confirmo'), true);
});

test('confirmação: não interpreta pergunta, objeção ou alteração como aprovação', () => {
  assert.equal(isNaturalAffirmation('Sim, mas tenho uma dúvida.'), false);
  assert.equal(isNaturalAffirmation('Sim, pode marcar para amanhã às 16h.'), false);
  assert.equal(isNaturalAffirmation('Pode explicar melhor?'), false);
  assert.equal(isNaturalAffirmation('Não, pode cancelar.'), false);
});

test('recusa: aceita negativas curtas e inequívocas', () => {
  assert.equal(isNaturalNegative('não'), true);
  assert.equal(isNaturalNegative('cancela'), true);
  assert.equal(isNaturalNegative('melhor não.'), true);
});

test('recusa: não confunde dúvida ou ressalva com cancelamento', () => {
  assert.equal(isNaturalNegative('Não, mas me explica primeiro.'), false);
  assert.equal(isNaturalNegative('Não tenho certeza.'), false);
  assert.equal(isNaturalNegative('Talvez não.'), false);
});


test('Pix: perguntas conceituais não são tratadas como pedidos de cobrança', () => {
  assert.equal(isPixActionRequest('O que é Pix?'), false);
  assert.equal(isPixActionRequest('Como funciona o Pix copia e cola?'), false);
  assert.equal(isPixActionRequest('Vocês aceitam Pix?'), false);
  assert.equal(resolvePaymentChoice('Me explica o checkout'), null);
});

test('Pix: reconhece pedidos de ação e escolhas concretas', () => {
  assert.equal(isPixActionRequest('Me passa a chave Pix'), true);
  assert.equal(isPixActionRequest('Quero gerar uma cobrança Pix de 80 reais'), true);
  assert.equal(resolvePaymentChoice('Quero o código copia e cola'), 'pix');
  assert.equal(resolvePaymentChoice('Prefiro checkout com cartão'), 'checkout');
  assert.equal(resolvePaymentChoice('Só a chave Pix'), 'key');
});

test('Pix: não aceita uma opção rejeitada como se fosse escolha', () => {
  assert.equal(resolvePaymentChoice('Não quero checkout'), null);
  assert.equal(resolvePaymentChoice('Não quero checkout, prefiro Pix copia e cola'), 'pix');
  assert.equal(resolvePaymentChoice('Não quero Pix nem checkout'), null);
});


test('Pix: entende pedidos naturais e coloquiais de chave simples', () => {
  for (const phrase of [
    'Me envie o Pix',
    'Me manda o pix',
    'Manda o pix pra mim',
    'Pode enviar a chave Pix?',
    'Me passa os dados do Pix',
    'Compartilha a chave pra eu pagar'
  ]) {
    assert.equal(isPixActionRequest(phrase), true, phrase);
    assert.equal(resolvePaymentChoice(phrase), 'key', phrase);
  }
});

test('Pix: diferencia chave simples de cobrança e modalidades digitais', () => {
  assert.equal(resolvePaymentChoice('Gera um Pix copia e cola de R$ 10'), 'pix');
  assert.equal(resolvePaymentChoice('Quero um QR Code Pix'), 'pix');
  assert.equal(resolvePaymentChoice('Me manda o Pix de 10 reais'), 'pix');
  assert.equal(resolvePaymentChoice('Me envie o link de pagamento'), 'checkout');
  assert.equal(resolvePaymentChoice('O que é a chave Pix?'), null);
  assert.equal(resolvePaymentChoice('Não quero Pix'), null);
});
