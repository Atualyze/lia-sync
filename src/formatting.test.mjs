import test from 'node:test';
import assert from 'node:assert/strict';
import { filterReply } from './safety.mjs';
import { GREETING_MESSAGE, ATENDIMENTO_EM_PROGRESSO_MESSAGE, TALK_TO_TAIS_MESSAGE, buildSystemPrompt } from './knowledge.mjs';

test('Formatação: filterReply converte markdown em negrito do WhatsApp e ajusta bullets', () => {
  const input = '**Importante:** Aqui está o resumo:\n- Item 1\n* Item 2 • Item 3';
  const { text } = filterReply(input);

  assert.match(text, /\*Importante:\*/, 'Deve converter ** para *');
  assert.match(text, /• Item 1/, 'Deve converter - para •');
  assert.match(text, /• Item 2\n• Item 3/, 'Deve colocar cada bullet point em sua própria linha');
});

test('Formatação: Mensagens padrão possuem quebras de linha e destaques visuais', () => {
  assert.ok(GREETING_MESSAGE.includes('\n\n'), 'Saudação deve ter quebras duplas de parágrafo');
  assert.match(GREETING_MESSAGE, /\*Lia\*/, 'Saudação deve destacar o nome Lia');
  assert.match(GREETING_MESSAGE, /\*Tauan\*/, 'Saudação deve destacar o nome Tauan');
  assert.ok(GREETING_MESSAGE.includes('• '), 'Saudação deve listar opções com bullets');

  assert.ok(ATENDIMENTO_EM_PROGRESSO_MESSAGE.includes('\n\n'));
  assert.match(ATENDIMENTO_EM_PROGRESSO_MESSAGE, /• \*Anotar o seu recado\*/);

  assert.ok(TALK_TO_TAIS_MESSAGE.includes('\n\n'));
  assert.match(TALK_TO_TAIS_MESSAGE, /\*Tauan\*/);
});

test('Formatação: System Prompt instrui distribuição visual com quebras e negritos', () => {
  const prompt = buildSystemPrompt({ session: { history: [] } });
  assert.match(prompt, /DIRETRIZES DE FORMATAÇÃO E LEITURA/);
  assert.match(prompt, /parágrafos curtos/);
  assert.match(prompt, /quebra de linha dupla/);
  assert.match(prompt, /\*negrito\*/);
});
