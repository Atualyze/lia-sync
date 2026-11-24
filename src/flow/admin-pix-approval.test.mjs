import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdminPixDecisionNotice,
  describePendingAdminPixDecision,
  listAdminPixDecisionsForAssumption,
  listPendingAdminPixDecisions,
  matchPendingAdminPixDecision,
  parseAdminPixDecision
} from './admin-pix-approval.mjs';

const now = Date.parse('2026-11-20T10:00:00.000Z');

function candidate(key, name, phone, amount = 5, minutesAgo = 1) {
  return {
    key,
    session: {
      phone,
      clientName: name,
      pendingAdminDecision: {
        type: 'pix_generation',
        status: 'pending',
        amount,
        description: 'Pagamento',
        requestedAt: new Date(now - minutesAgo * 60000).toISOString()
      }
    },
    decision: {
      type: 'pix_generation',
      status: 'pending',
      amount,
      requestedAt: new Date(now - minutesAgo * 60000).toISOString()
    }
  };
}

test('decisão Pix do administrador exige comando explícito', () => {
  assert.deepEqual(parseAdminPixDecision('GERAR PIX'), { action: 'generate', target: null });
  assert.deepEqual(parseAdminPixDecision('Autorizo gerar o Pix'), { action: 'generate', target: null });
  assert.deepEqual(parseAdminPixDecision('Pode gerar Pix para Ana'), { action: 'generate', target: 'ana' });
  assert.deepEqual(parseAdminPixDecision('GERAR PIX 2222'), { action: 'generate', target: '2222' });
  assert.deepEqual(parseAdminPixDecision('ASSUMIR ATENDIMENTO'), { action: 'assume', target: null });
  assert.deepEqual(parseAdminPixDecision('Vou assumir o atendimento da Ana'), { action: 'assume', target: 'ana' });
  assert.deepEqual(parseAdminPixDecision('ASSUMIR ATENDIMENTO 2222'), { action: 'assume', target: '2222' });
  assert.deepEqual(parseAdminPixDecision('Deixa comigo'), { action: 'assume', target: null });

  for (const ambiguous of ['sim', 'ok', 'pode', '5', 'confirma', 'gera', 'assume']) {
    assert.equal(parseAdminPixDecision(ambiguous), null, ambiguous);
  }
});

test('lista somente decisões Pix pendentes, válidas e dentro do prazo', () => {
  const sessions = {
    a: candidate('a', 'Ana', '5588999991111').session,
    b: candidate('b', 'Bruna', '5588999992222', 10, 45).session,
    c: {
      phone: '5588999993333',
      pendingAdminDecision: {
        type: 'pix_generation',
        status: 'completed',
        amount: 15,
        requestedAt: new Date(now - 60000).toISOString()
      }
    },
    d: {
      phone: '5588999994444',
      pendingAdminDecision: {
        type: 'pix_generation',
        status: 'pending',
        amount: 0,
        requestedAt: new Date(now - 60000).toISOString()
      }
    }
  };

  const result = listPendingAdminPixDecisions(sessions, { nowMs: now });
  assert.deepEqual(result.map(item => item.key), ['a']);
});

test('seleção de decisão Pix evita escolher contato errado quando há mais de um', () => {
  const ana = candidate('ana', 'Ana Silva', '5588999991111');
  const bruna = candidate('bruna', 'Bruna Costa', '5588999992222');
  const candidates = [ana, bruna];

  assert.equal(matchPendingAdminPixDecision(candidates), null);
  assert.equal(matchPendingAdminPixDecision(candidates, 'Ana'), ana);
  assert.equal(matchPendingAdminPixDecision(candidates, '2222'), bruna);
  assert.equal(matchPendingAdminPixDecision([ana], null), ana);
  assert.equal(matchPendingAdminPixDecision(candidates, '9999'), null);
});

test('ID da solicitação seleciona exatamente a cobrança vinculada ao botão', () => {
  const ana = candidate('ana', 'Ana Silva', '5588999991111');
  const bruna = candidate('bruna', 'Bruna Costa', '5588999992222');
  ana.decision.requestId = '11111111-1111-4111-8111-111111111111';
  ana.session.pendingAdminDecision.requestId = ana.decision.requestId;
  bruna.decision.requestId = '22222222-2222-4222-8222-222222222222';
  bruna.session.pendingAdminDecision.requestId = bruna.decision.requestId;

  assert.equal(matchPendingAdminPixDecision([ana, bruna], bruna.decision.requestId), bruna);
  assert.equal(matchPendingAdminPixDecision([ana, bruna], '33333333-3333-4333-8333-333333333333'), null);
});

test('notificação interna oferece exatamente as duas decisões sem alegar Pix gerado', () => {
  const message = buildAdminPixDecisionNotice({
    clientName: 'Ana',
    phone: '5588999991111',
    amount: 5,
    requestId: '11111111-1111-4111-8111-111111111111'
  });
  assert.match(message, /R\$ 5,00/);
  assert.match(message, /ID da solicitação: 11111111-1111-4111-8111-111111111111/);
  assert.match(message, /GERAR PIX 11111111-1111-4111-8111-111111111111/);
  assert.match(message, /GERAR PIX/);
  assert.match(message, /ASSUMIR ATENDIMENTO/);
  assert.match(message, /não será gerada/i);
  assert.deepEqual(describePendingAdminPixDecision(candidate('a', 'Ana', '5588999991111')), {
    name: 'Ana',
    suffix: '1111',
    label: 'Ana (final 1111)',
    amount: 5,
    requestedAt: new Date(now - 60000).toISOString()
  });
});


test('decisão com envio incerto pode ser assumida por humano, mas nunca reaparece para gerar Pix', () => {
  const uncertain = candidate('uncertain', 'Carlos', '5588999994444').session;
  uncertain.pendingAdminDecision.status = 'uncertain';
  const sessions = { uncertain };
  assert.equal(listPendingAdminPixDecisions(sessions, { nowMs: now }).length, 0);
  const assumable = listAdminPixDecisionsForAssumption(sessions);
  assert.equal(assumable.length, 1);
  assert.equal(assumable[0].decision.status, 'uncertain');
});

test('decisão Pix vencida pode ser assumida manualmente, mas não autorizada para nova geração', () => {
  const expired = candidate('expired', 'Bruna', '5588999995555', 10, 90).session;
  const sessions = { expired };
  assert.equal(listPendingAdminPixDecisions(sessions, { nowMs: now }).length, 0);
  assert.equal(listAdminPixDecisionsForAssumption(sessions).length, 1);
});
