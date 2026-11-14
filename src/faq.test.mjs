import test from 'node:test';
import assert from 'node:assert/strict';
import { findDynamicFaq, getPlansForPrompt, plansToFaq, getAllowedPrices, faqAgeSeconds } from './faq.mjs';

test('findDynamicFaq encontra item correspondente por palavras-chave', () => {
  const items = [
    { keys: ['horario', 'atendimento'], answer: 'Das 8h as 18h.' }
  ];
  const hit = findDynamicFaq('qual o horario?', items);
  assert.equal(hit, 'Das 8h as 18h.');
  assert.equal(findDynamicFaq('assunto inexistente xyz', items), null);
});

test('plansToFaq converte lista de planos e funcoes auxiliares retornam tipos esperados', () => {
  const faq = plansToFaq([{ name: 'Basico', price: 'R$ 99', description: 'Plano inicial' }]);
  assert.ok(Array.isArray(faq));
  assert.ok(getAllowedPrices() instanceof Set);
  assert.ok(Array.isArray(getPlansForPrompt()));
  assert.equal(faqAgeSeconds(), null);
});
