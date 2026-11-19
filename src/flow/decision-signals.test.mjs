import test from 'node:test';
import assert from 'node:assert/strict';
import { isNaturalAffirmation, isNaturalNegative } from './decision-signals.mjs';

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
