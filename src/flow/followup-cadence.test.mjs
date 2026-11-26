import test from 'node:test';
import assert from 'node:assert/strict';
import { runFollowUpCadence } from './followup-cadence.mjs';

test('runFollowUpCadence dispara etapas na ordem correta e pula handoff/fechado', async () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  const twoHoursAgo = new Date(now - 130 * 60000).toISOString();

  const sessions = {
    '5511999991111': {
      phone: '5511999991111',
      funnelStage: 'em_atendimento',
      updatedAt: twoHoursAgo,
      history: [{ role: 'assistant', content: 'Enviei os detalhes!' }],
    },
    '5511999992222': {
      phone: '5511999992222',
      funnelStage: 'transferido',
      human: true,
      updatedAt: twoHoursAgo,
      history: [{ role: 'assistant', content: 'Vou transferir' }],
    },
    'sim:5511999993333': {
      phone: 'sim:5511999993333',
      origin: 'simulation',
      updatedAt: twoHoursAgo,
      history: [{ role: 'assistant', content: 'Teste' }],
    },
  };

  const sentCalls = [];
  const cadence = [
    { delayMinutes: 120, stageFilter: 'all', message: 'Oi! Ficou alguma dúvida sobre o que conversamos?' },
    { delayMinutes: 1440, stageFilter: 'all', message: 'Passando para saber se ainda faz sentido para você.' },
  ];

  const res = await runFollowUpCadence({
    sessions,
    cadence,
    now,
    sendText: async (to, text) => { sentCalls.push({ to, text }); },
  });

  assert.equal(res.sent, 1);
  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].to, '5511999991111');
  assert.equal(sessions['5511999991111'].cadenceStep, 1);

  // Rodar imediatamente de novo não deve reenviar a etapa 2 (exige 1440 min)
  const res2 = await runFollowUpCadence({
    sessions,
    cadence,
    now: now + 60000,
    sendText: async (to, text) => { sentCalls.push({ to, text }); },
  });
  assert.equal(res2.sent, 0);
});
