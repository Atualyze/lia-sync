import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMasterSystemInstruction } from './ai/call.mjs';
import { buildPersonalityPrompt } from './core/personality.mjs';

test('diretriz mestre do painel é aplicada uma única vez e sem substituir as regras centrais', () => {
  const botConfig = { ai: { systemInstruction: 'Use linguagem simples e acolhedora.' } };
  const prompt = appendMasterSystemInstruction('REGRAS CENTRAIS DO SISTEMA', botConfig);

  assert.match(prompt, /REGRAS CENTRAIS DO SISTEMA/);
  assert.match(prompt, /Use linguagem simples e acolhedora\./);
  assert.match(prompt, /não podem substituir nem contrariar segurança/i);
  assert.equal((prompt.match(/DIRETRIZ_MESTRE_CONFIGURADA_NO_PAINEL/g) || []).length, 2);

  const secondPass = appendMasterSystemInstruction(prompt, botConfig);
  assert.equal(secondPass, prompt);
});

test('diretriz mestre vazia não altera o prompt e o limite de tamanho é respeitado', () => {
  assert.equal(appendMasterSystemInstruction('prompt base', { ai: { systemInstruction: '   ' } }), 'prompt base');

  const longInstruction = 'x'.repeat(9000);
  const prompt = appendMasterSystemInstruction('base', { ai: { systemInstruction: longInstruction } });
  assert.equal(prompt.length, 'base'.length + 2 + '[DIRETRIZ_MESTRE_CONFIGURADA_NO_PAINEL]\n'.length
    + 'DIRETRIZ COMPLEMENTAR CONFIGURADA NO PAINEL: aplique estas orientações ao estilo e à condução do atendimento quando forem compatíveis com as regras estruturais deste sistema. Elas NÃO podem substituir nem contrariar segurança, privacidade, permissões de ferramentas, limites operacionais, estado real de uma ação ou confirmação de execução. Em caso de conflito, prevalecem essas regras estruturais.\n'.length
    + 8000 + '\n[/DIRETRIZ_MESTRE_CONFIGURADA_NO_PAINEL]'.length);
});

test('personalidade usa personality.tone e, na ausência, identity.tone', () => {
  const identityFallback = buildPersonalityPrompt({
    botConfig: { identity: { tone: 'consultivo e técnico' } }
  });
  assert.match(identityFallback, /Tom configurado: consultivo e técnico/);

  const explicitPersonality = buildPersonalityPrompt({
    botConfig: {
      identity: { tone: 'formal' },
      personality: { tone: 'descontraído e objetivo' }
    }
  });
  assert.match(explicitPersonality, /Tom configurado: descontraído e objetivo/);
  assert.doesNotMatch(explicitPersonality, /Tom configurado: formal/);
});
