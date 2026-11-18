import test from 'node:test';
import assert from 'node:assert/strict';
import { selectActiveClientHistory } from './client-context.mjs';

const stamp = value => new Date(value).toISOString();

test('contexto de cliente: uma pausa longa separa o assunto ativo sem apagar o histórico', () => {
  const history = [
    { role: 'user', content: 'Preciso do Pix', createdAt: stamp('2026-11-18T15:57:26Z') },
    { role: 'assistant', content: 'Qual valor da cobrança?', createdAt: stamp('2026-11-18T15:58:20Z') },
    { role: 'user', content: '10', createdAt: stamp('2026-11-18T15:59:22Z') },
    { role: 'user', content: 'Oi', createdAt: stamp('2026-11-18T21:53:52Z') },
    { role: 'assistant', content: 'Boa tarde! Como posso te ajudar hoje?', createdAt: stamp('2026-11-18T21:53:54Z') },
    { role: 'user', content: 'Como assim?', createdAt: stamp('2026-11-18T21:54:19Z') }
  ];

  const selected = selectActiveClientHistory(history, {
    maxTurns: 24,
    nowMs: Date.parse('2026-11-18T21:54:19Z')
  });

  assert.equal(selected.topicBoundary, true);
  assert.deepEqual(selected.history.map(message => message.content), [
    'Oi',
    'Boa tarde! Como posso te ajudar hoje?',
    'Como assim?'
  ]);
  assert.equal(history.length, 6, 'o histórico persistido permanece íntegro');
  assert.equal(history[0].content, 'Preciso do Pix');
});

test('contexto de cliente: operação pendente mantém continuidade mesmo após pausa longa', () => {
  const history = [
    { role: 'user', content: 'Preciso do Pix', createdAt: stamp('2026-11-18T15:57:26Z') },
    { role: 'assistant', content: 'Qual valor da cobrança?', createdAt: stamp('2026-11-18T15:58:20Z') },
    { role: 'user', content: 'Oi', createdAt: stamp('2026-11-18T21:53:52Z') }
  ];

  const selected = selectActiveClientHistory(history, {
    maxTurns: 24,
    nowMs: Date.parse('2026-11-18T21:53:52Z'),
    preservePendingContext: true
  });

  assert.equal(selected.topicBoundary, false);
  assert.deepEqual(selected.history, history);
});
