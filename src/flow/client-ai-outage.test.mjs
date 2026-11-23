import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAIUnavailableReply } from './client.mjs';

test('AI outage response uses conversation context and disables tools', async () => {
  let callArgs;
  const reply = await buildAIUnavailableReply({
    ai: { askAI: async args => { callArgs = args; return { reply: 'Sobre o horário de sábado, ainda não tenho uma confirmação confiável.' }; } },
    session: { history: [{ role: 'user', content: 'Vocês abrem aos sábados?' }], contextSummary: 'Horário de funcionamento' },
    currentText: 'E neste sábado?',
    botConfig: { ai: {} },
    now: () => 1_000
  });
  assert.match(reply, /sábado/i);
  assert.equal(callArgs.disableToolCalling, true);
  assert.equal(callArgs.deadline, 3_500);
  assert.equal(callArgs.history[0].content, 'Vocês abrem aos sábados?');
});

test('AI outage response falls back to a message contextual to the unanswered request', async () => {
  const reply = await buildAIUnavailableReply({
    ai: { askAI: async () => { throw new Error('provider unavailable'); } },
    session: {},
    currentText: 'Preciso saber o horário de atendimento',
    now: () => 5_000
  });
  assert.match(reply, /horário de atendimento/i);
  assert.doesNotMatch(reply, /API|provedor|erro técnico/i);
  assert.doesNotMatch(reply, /vou encaminhar|em instantes|te retorno/i);
});
