import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCopilotToolReview, reviewCopilotToolCall, hasExplicitToolIntent, hasOtherExplicitToolIntent } from './copilot-continuity.mjs';

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


test('classifica pergunta de esclarecimento como conversa, não como resposta de tarefa', async () => {
  const { classifyCopilotTurn } = await import('./copilot-continuity.mjs');
  const review = await classifyCopilotTurn({
    ai: { askAI: async () => ({ reply: '{"intent":"clarification","confidence":0.98,"reason":"pergunta sobre a resposta"}' }) },
    currentMessage: 'O que você não entendeu exatamente?',
    activeTask: { type: 'payment', originCommand: 'Gerar cobrança Pix', lastQuestion: 'Me informe o valor.' },
    recentContext: [{ role: 'assistant', content: 'Ainda não entendi o que você quer fazer.' }]
  });
  assert.equal(review.intent, 'clarification');
});

test('classifica resposta curta como continuação quando responde à última pergunta', async () => {
  const { classifyCopilotTurn } = await import('./copilot-continuity.mjs');
  const review = await classifyCopilotTurn({
    ai: { askAI: async () => ({ reply: '{"intent":"continue","confidence":0.96,"reason":"valor solicitado"}' }) },
    currentMessage: '10',
    activeTask: { type: 'payment', originCommand: 'Gerar cobrança Pix', lastQuestion: 'Qual valor devo cobrar?' },
    recentContext: [{ role: 'assistant', content: 'Qual valor devo cobrar?' }]
  });
  assert.equal(review.intent, 'continue');
});

test('classificação falha de forma segura quando o avaliador não responde', async () => {
  const { classifyCopilotTurn } = await import('./copilot-continuity.mjs');
  const review = await classifyCopilotTurn({
    ai: { askAI: async () => ({ reply: 'não sei' }) },
    currentMessage: '10',
    activeTask: { type: 'payment', originCommand: 'Gerar cobrança Pix' }
  });
  assert.equal(review.intent, 'clarification');
});


test('intenção explícita de ferramenta não confunde menção com autorização', () => {
  assert.equal(hasExplicitToolIntent('Gera uma cobrança Pix de 80 reais', 'gerar_cobranca_pix'), true);
  assert.equal(hasExplicitToolIntent('Não gere a cobrança ainda', 'gerar_cobranca_pix'), false);
  assert.equal(hasExplicitToolIntent('Não entendi a cobrança, pode explicar?', 'gerar_cobranca_pix'), false);
  assert.equal(hasExplicitToolIntent('Quero entender como funciona o Pix', 'gerar_cobranca_pix'), false);
  assert.equal(hasExplicitToolIntent('Mande uma mensagem para João dizendo que chego às 15h', 'enviar_mensagem_contato'), true);
  assert.equal(hasExplicitToolIntent('Não mande mensagem para João', 'enviar_mensagem_contato'), false);
  assert.equal(hasExplicitToolIntent('Quais horários estão livres na agenda?', 'gerenciar_agenda_google'), true);
});

test('correção de mensagem não é confundida com pedido explícito de envio', () => {
  assert.equal(hasExplicitToolIntent('Não, não mande para João. Corrija para Maria.', 'enviar_mensagem_contato'), false);
});


test('classificador trata resposta negativa sobre envio como esclarecimento, não como continuação autorizada', async () => {
  const { classifyCopilotTurn } = await import('./copilot-continuity.mjs');
  const review = await classifyCopilotTurn({
    ai: { askAI: async () => ({ reply: '{"intent":"clarification","confidence":0.97,"reason":"pedido para não enviar ainda"}' }) },
    currentMessage: 'Não envie ainda, quero revisar o texto.',
    activeTask: { type: 'dispatch', originCommand: 'Enviar mensagem para João', lastQuestion: 'Posso enviar a mensagem agora?' },
    recentContext: [{ role: 'assistant', content: 'Posso enviar a mensagem agora?' }]
  });
  assert.equal(review.intent, 'clarification');
});

test('continuação com confiança baixa é rebaixada para esclarecimento', async () => {
  const { classifyCopilotTurn } = await import('./copilot-continuity.mjs');
  const review = await classifyCopilotTurn({
    ai: { askAI: async () => ({ reply: '{"intent":"continue","confidence":0.58,"reason":"talvez seja continuação"}' }) },
    currentMessage: 'Pode ser',
    activeTask: { type: 'agenda', originCommand: 'Consultar agenda', lastQuestion: 'Você quer consultar ou agendar?' },
    recentContext: [{ role: 'assistant', content: 'Você quer consultar ou agendar?' }]
  });
  assert.equal(review.intent, 'clarification');
  assert.equal(review.reason, 'low_confidence_continuation');
});


test('intenção de saúde reconhece atualização seguida de verificação do sistema', () => {
  assert.equal(hasExplicitToolIntent('Rodei uma atualização, gostaria de saber se está tudo ok', 'consultar_saude_infra'), true);
  assert.equal(hasExplicitToolIntent('Depois do deploy, está funcionando normalmente?', 'consultar_saude_infra'), true);
  assert.equal(hasExplicitToolIntent('Como está o servidor depois da atualização?', 'consultar_saude_infra'), true);
});

test('intenção explícita: reconhece comandos curtos, mas não transforma dúvidas em ações', () => {
  assert.equal(hasExplicitToolIntent('Pix', 'gerar_cobranca_pix'), true);
  assert.equal(hasExplicitToolIntent('Como funciona o Pix?', 'gerar_cobranca_pix'), false);
  assert.equal(hasExplicitToolIntent('Vocês aceitam Pix?', 'gerar_cobranca_pix'), false);
  assert.equal(hasExplicitToolIntent('Quero cobrar R$ 20 pela compra', 'gerar_cobranca_pix'), true);
  assert.equal(hasExplicitToolIntent('Me explica como funciona o envio de áudio', 'enviar_mensagem_contato'), false);
});

test('intenção explícita: distingue pedido de nova ação de continuação de envio', () => {
  assert.equal(hasOtherExplicitToolIntent('Mande uma mensagem para o Lima', 'gerar_cobranca_pix'), true);
  assert.equal(hasOtherExplicitToolIntent('Não mande mensagem para o Lima', 'gerar_cobranca_pix'), false);
});


test('escolha Pix direto reconhece resposta curta no contexto da pergunta', async () => {
  const { isDirectPixChoice } = await import('./copilot-continuity.mjs');
  const question = 'Você prefere que eu gere o Pix direto (Copia e Cola / QR Code) ou o link do Checkout InfinitePay (Pix e Cartão)?';
  assert.equal(isDirectPixChoice('Direto', question), true);
  assert.equal(isDirectPixChoice('Copia e Cola', question), true);
  assert.equal(isDirectPixChoice('QR Code', question), true);
  assert.equal(isDirectPixChoice('Direto', 'Qual é o valor da cobrança?'), false);
});

test('perguntas de status reconhecem estou esperando e onde está', async () => {
  const { isCopilotTaskStatusQuestion } = await import('./copilot-continuity.mjs');
  assert.equal(isCopilotTaskStatusQuestion('estou esperando'), true);
  assert.equal(isCopilotTaskStatusQuestion('Onde está?'), true);
  assert.equal(isCopilotTaskStatusQuestion('cadê o resultado?'), true);
  assert.equal(isCopilotTaskStatusQuestion('O que houve?'), true);
  assert.equal(isCopilotTaskStatusQuestion('Alguma novidade?'), true);
  assert.equal(isCopilotTaskStatusQuestion('vamos conversar'), false);
});
