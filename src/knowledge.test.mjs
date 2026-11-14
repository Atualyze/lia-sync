import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, isEmergency, isAffirmative, isGreeting, findFaqInItems, findFaq, buildSystemPrompt } from './knowledge.mjs';

test('helpers de texto reconhecem saudacoes, afirmacoes e emergencias', () => {
  assert.equal(normalize('  Olá, Tudo Bem? '), 'ola tudo bem');
  assert.equal(isGreeting('oi'), true);
  assert.equal(isAffirmative('sim'), true);
  assert.equal(isEmergency('socorro emergencia'), true);
  assert.equal(isEmergency('bom dia'), false);
});

test('findFaqInItems e findFaq buscam respostas e buildSystemPrompt gera prompt', () => {
  const items = [{ keys: ['preco', 'valor'], answer: 'Consulte a tabela.' }];
  assert.equal(findFaqInItems('qual o preco?', items), 'Consulte a tabela.');
  assert.ok(findFaq('horario') === null || typeof findFaq('horario') === 'string');
  const prompt = buildSystemPrompt({ session: { phone: '5511999998888', history: [] } });
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length > 20);
});
