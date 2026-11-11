import test from 'node:test';
import assert from 'node:assert/strict';
import { filterReply } from './safety.mjs';
import { formatOutgoingMessage } from './core/format.mjs';
import { buildSystemPrompt } from './knowledge.mjs';
import { buildGreetingMessage, buildAtendimentoMessage, buildTalkToOwnerMessage } from './core/messages.mjs';

test('Formatação: filterReply converte markdown em negrito do WhatsApp e ajusta bullets', () => {
  const input = '**Importante:** Aqui está o resumo:\n- Item 1\n* Item 2 • Item 3';
  const { text } = filterReply(input);

  assert.match(text, /\*Importante:\*/, 'Deve converter ** para *');
  assert.match(text, /• Item 1/, 'Deve converter - para •');
  assert.match(text, /• Item 2\n• Item 3/, 'Deve colocar cada bullet point em sua própria linha');
});

test('Formatação: Mensagens padrão possuem quebras de linha e destaques visuais', () => {
  const greeting = buildGreetingMessage();
  assert.ok(greeting.includes('\n\n'), 'Saudação deve ter quebras duplas de parágrafo');
  assert.match(greeting, /\*Lia\*/, 'Saudação deve destacar o nome da assistente');
  assert.match(greeting, /\*Equipe de Atendimento\*/, 'Saudação deve destacar o responsável configurado');
  assert.ok(greeting.includes('• '), 'Saudação deve listar opções com bullets');

  const atendimento = buildAtendimentoMessage();
  assert.ok(atendimento.includes('\n\n'));
  assert.match(atendimento, /• \*Anotar o seu recado\*/);

  const talkToOwner = buildTalkToOwnerMessage();
  assert.ok(talkToOwner.includes('\n\n'));
  assert.match(talkToOwner, /\*Equipe de Atendimento\*/);
});

test('Formatação: System Prompt instrui distribuição visual com quebras e negritos', () => {
  const prompt = buildSystemPrompt({ session: { history: [] } });
  assert.match(prompt, /DIRETRIZES DE FORMATAÇÃO E LEITURA/);
  assert.match(prompt, /parágrafos curtos/);
  assert.match(prompt, /quebra de linha dupla/);
  assert.match(prompt, /\*negrito\*/);
});

test('Formatação: formatOutgoingMessage destaca rótulos e distribui parágrafos', () => {
  const out = formatOutgoingMessage(
    'Conexão WhatsApp: conectado\nAtendimentos em andamento: 6\n' +
    'O sistema segue estável. ' + 'A verificação de todos os serviços foi concluída com sucesso e nenhum erro foi encontrado nos circuitos de proteção. '.repeat(6) +
    'Latência média de 320 milissegundos.'
  );

  assert.match(out, /\*Conexão WhatsApp:\* conectado/, 'Rótulo deve ganhar negrito');
  assert.match(out, /\*Atendimentos em andamento:\* 6/, 'Rótulo numérico deve ganhar negrito');
  assert.ok(!/[^\n]{340,}/.test(out.replace(/\*/g, '')), 'Não deve deixar parágrafo denso sem quebra');
  assert.ok(!/\n{3,}/.test(out), 'Espaçamento deve ser estável');
});

test('Formatação: formatOutgoingMessage é idempotente e preserva bullets', () => {
  const input = '*Resumo:*\n• item um\n• item dois';
  const once = formatOutgoingMessage(input);
  assert.equal(once, formatOutgoingMessage(once), 'Aplicar duas vezes não deve alterar');
  assert.match(once, /• item um/);
});
