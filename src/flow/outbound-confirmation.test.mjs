import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchOutboundApproval,
  matchOutboundCancellation,
  isExplicitCopilotCancellation
} from './outbound-confirmation.mjs';

test('confirmações aceitam aprovações explícitas e complementos de cortesia', () => {
  for (const text of ['sim', 'sim, pode enviar agora', 'sim, manda', 'sim, envia', 'pode gravar, por favor', 'vai', 'confirmo']) {
    assert.ok(matchOutboundApproval(text), 'deveria reconhecer: ' + text);
  }
  for (const text of ['sim, mas espere', 'pode enviar? tenho uma dúvida']) {
    assert.equal(matchOutboundApproval(text), null, 'não deveria confirmar: ' + text);
  }
});

test('negativas conversacionais não cancelam uma prévia pendente', () => {
  for (const text of ['Não entendi, pode explicar?', 'Não, pode explicar melhor?', 'Para quando fica o orçamento?', 'Não precisa explicar isso']) {
    assert.equal(matchOutboundCancellation(text), null, 'não deveria cancelar: ' + text);
  }
  for (const text of ['não', 'não precisa', 'não precisa mandar', 'não envia', 'não, cancela', 'cancela', 'cancela isso', 'cancela o envio', 'pode cancelar o envio', 'deixa pra lá']) {
    assert.ok(matchOutboundCancellation(text), 'deveria reconhecer cancelamento: ' + text);
  }
});

test('negativa isolada só cancela no cancelamento geral quando existe pendência', () => {
  assert.equal(isExplicitCopilotCancellation('não', { hasPending: false }), false);
  assert.equal(isExplicitCopilotCancellation('não', { hasPending: true }), true);
  assert.equal(isExplicitCopilotCancellation('Não entendi, pode explicar?', { hasPending: true }), false);
  assert.equal(matchOutboundCancellation('não cancela'), null, 'a instrução para não cancelar deve preservar a prévia');
  assert.equal(isExplicitCopilotCancellation('não cancela', { hasPending: true }), false);
  assert.equal(isExplicitCopilotCancellation('cancela', { hasPending: false }), true);
});
