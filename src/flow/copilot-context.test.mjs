import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCopilotContext } from './copilot-context.mjs';

test('monta contexto operacional estruturado sem inferir entrega de disparo incerto', () => {
  const context = buildCopilotContext({
    owner: 'Responsável',
    latestMessage: 'Ok, marque como concluído',
    identity: { assistantName: 'Lia', companyName: 'Atualyze' },
    now: Date.parse('2026-11-20T12:00:00.000Z'),
    session: {
      isInternalChat: true,
      pendingOutboundDispatch: {
        id: 'DISP123',
        recipient: 'ptbr',
        message: 'Mensagem preparada',
        status: 'uncertain',
        createdAt: '2026-11-20T08:00:00.000Z'
      },
      pendingCopilotTask: {
        type: 'dispatch',
        originCommand: 'Preparar mensagem',
        lastQuestion: 'O disparo está incerto.',
        allowedTools: ['enviar_mensagem_contato']
      },
      history: [{ role: 'assistant', content: 'O disparo está incerto.' }]
    }
  });

  assert.equal(context.latestUserMessage, 'Ok, marque como concluído');
  assert.equal(context.actor.role, 'owner');
  assert.equal(context.activeTask.type, 'dispatch');
  assert.equal(context.pendingActions.outboundDispatch.status, 'uncertain');
  assert.equal(context.pendingActions.outboundDispatch.deliveryConfirmed, false);
  assert.equal(context.conversation.recentHistory.length, 1);
});

test('limita histórico e remove entradas vazias', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `mensagem ${i}` }));
  const context = buildCopilotContext({ session: { history } });
  assert.equal(context.conversation.recentHistory.length, 12);
  assert.equal(context.conversation.recentHistory[0].content, 'mensagem 8');
});
