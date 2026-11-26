import test from 'node:test';
import assert from 'node:assert/strict';
import { sendReputationSurvey, handleReputationReply } from './reputation.mjs';

test('sendReputationSurvey envia pesquisa uma única vez e handleReputationReply envia link Google para nota alta', async () => {
  const session = { phone: '5511999991111' };
  const sent = [];
  const reputationConfig = {
    enabled: true,
    minPositiveRating: 4,
    googleReviewUrl: 'https://g.page/r/exemplo/review',
    surveyMessage: 'De 1 a 5, como foi seu atendimento?',
  };

  const r1 = await sendReputationSurvey({
    session,
    phone: '5511999991111',
    sendText: async (to, text) => sent.push({ to, text }),
    reputationConfig,
  });
  assert.equal(r1.sent, true);
  assert.equal(session.reputationAwaitingRating, true);

  // Não reenvia se já foi enviada
  const r2 = await sendReputationSurvey({
    session,
    phone: '5511999991111',
    sendText: async (to, text) => sent.push({ to, text }),
    reputationConfig,
  });
  assert.equal(r2.sent, false);

  // Nota 5 -> envia link do Google
  const replyHigh = await handleReputationReply({
    session,
    text: '5',
    phone: '5511999991111',
    sendText: async (to, text) => sent.push({ to, text }),
    reputationConfig,
  });
  assert.equal(replyHigh.handled, true);
  assert.equal(replyHigh.positive, true);
  assert.match(sent[1].text, /g\.page\/r\/exemplo\/review/);
});

test('handleReputationReply nota baixa não envia link do Google', async () => {
  const session = { phone: '5511999992222', reputationAwaitingRating: true };
  const sent = [];
  const res = await handleReputationReply({
    session,
    text: '2',
    phone: '5511999992222',
    sendText: async (to, text) => sent.push({ to, text }),
    reputationConfig: {
      enabled: true,
      minPositiveRating: 4,
      googleReviewUrl: 'https://g.page/r/exemplo/review',
    },
  });
  assert.equal(res.handled, true);
  assert.equal(res.positive, false);
  assert.doesNotMatch(sent[0].text, /g\.page/);
});
