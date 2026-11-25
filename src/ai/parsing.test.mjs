import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAIResponse } from './parsing.mjs';

test('parseAIResponse descarta marcadores de exemplo em reply', () => {
  const replies = [
    'Resposta natural pronta para WhatsApp',
    'SUA RESPOSTA BEM FORMATADA COM QUEBRAS DE LINHA DUPLAS, NEGRITOS E EMOJIS.'
  ];

  for (const reply of replies) {
    const parsed = parseAIResponse(JSON.stringify({ reply, intent: 'outro', red_flags: false, handoff: false }));
    assert.equal(parsed.reply, '');
  }
});

test('parseAIResponse preserva respostas reais', () => {
  const parsed = parseAIResponse(JSON.stringify({
    reply: 'Claro! Qual nome e telefone devo salvar?',
    intent: 'comando',
    red_flags: false,
    handoff: false
  }));

  assert.equal(parsed.reply, 'Claro! Qual nome e telefone devo salvar?');
});
