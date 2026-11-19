import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCopilotToolReview, reviewCopilotToolCall } from './copilot-continuity.mjs';

test('review semântico reconhece continuação natural sem depender de palavra-chave', async () => {
  let captured = null;
  const review = await reviewCopilotToolCall({
    ai: {
      askAI: async args => {
        captured = args;
        return {
          reply: JSON.stringify({
            decision: 'allow',
            relation: 'continuation',
            question: '',
            reason: 'resposta complementa a pergunta ativa'
          })
        };
      }
    },
    currentMessage: 'É esse mesmo, pode seguir com o que estávamos vendo.',
    activeTask: {
      type: 'payment',
      originCommand: 'Preciso cobrar aquela entrega',
      lastQuestion: 'Qual valor devo colocar?',
      allowedTools: []
    },
    toolCall: { name: 'gerar_cobranca_pix', args: { valor: 85, descricao: 'entrega' } },
    recentContext: [{ role: 'assistant', content: 'Qual valor devo colocar?' }],
    botConfig: { ai: { enableToolCalling: true } }
  });

  assert.equal(review.decision, 'allow');
  assert.equal(review.relation, 'continuation');
  assert.equal(captured.disableToolCalling, true);
  assert.deepEqual(captured.history, []);
});

test('review semântico pede contexto quando a ferramenta proposta não está ligada ao pedido', async () => {
  const review = await reviewCopilotToolCall({
    ai: {
      askAI: async () => ({
        reply: JSON.stringify({
          decision: 'clarify',
          relation: 'unrelated',
          question: 'Você quer que eu consulte esse contato ou estava falando de outra coisa?',
          reason: 'a mensagem não pede consulta'
        })
      })
    },
    currentMessage: 'Não entendi direito o que aconteceu.',
    toolCall: { name: 'enviar_mensagem_contato', args: { recipient: 'João', message: 'Oi' } }
  });

  assert.equal(review.decision, 'clarify');
  assert.equal(review.relation, 'unrelated');
  assert.match(review.question, /consulte esse contato/i);
});

test('resposta inválida do avaliador falha fechada e pede contexto', () => {
  const review = parseCopilotToolReview({ reply: 'Não consegui analisar.' }, { hasActiveTask: true });
  assert.equal(review.decision, 'clarify');
  assert.equal(review.relation, 'continuation');
  assert.match(review.question, /continuar a solicitação anterior/i);
});

test('não considera sugestão do próprio modelo como autorização automática', async () => {
  const review = await reviewCopilotToolCall({
    ai: { askAI: async () => ({ reply: '{"decision":"deny","relation":"unrelated","question":"","reason":"sem vínculo"}' }) },
    currentMessage: 'Obrigado, era só isso.',
    activeTask: null,
    toolCall: { name: 'gerenciar_agenda_google', args: { action: 'criar' } }
  });
  assert.equal(review.decision, 'deny');
});
