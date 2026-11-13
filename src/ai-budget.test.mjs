import test from 'node:test';
import assert from 'node:assert/strict';
import { AIBudgetGate } from './ai/budget.mjs';

const now = () => new Date('2026-11-13T14:00:00.000Z');
const config = {
  pricingRates: [
    { provider: 'gemini', model: 'model-a', inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
    { provider: 'gemini', model: 'model-b', inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
    { provider: 'openai', model: 'gpt-x', inputUsdPerMillion: 1, outputUsdPerMillion: 1 }
  ],
  monthlyBudgets: [{ amountUsd: 0.003 }]
};

function createGate({ rows = [], fail = null } = {}) {
  return new AIBudgetGate({
    operationsStore: {
      async listMonthlyCalls() {
        if (fail) throw fail;
        return rows;
      }
    },
    logger: { warn() {} },
    now
  });
}

const request = (gate, model = 'model-a', aiConfig = config) => gate.acquire({
  provider: 'gemini', model, aiConfig,
  system: 'sistema', userText: 'oi', history: [], maxOutputTokens: 2048
});

test('budget global permite primeira reserva e bloqueia concorrente que ultrapassaria o teto', async () => {
  const gate = createGate();
  const [first, second] = await Promise.all([request(gate), request(gate)]);
  assert.equal(first.allowed, true);
  assert.ok(first.requestId);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'monthly_budget_exceeded');
});

test('reserva distribuída serializa instâncias independentes antes de iniciar chamadas', async () => {
  const reservations = new Map();
  let queue = Promise.resolve();
  const operationsStore = {
    reserveAIBudget(input) {
      const run = queue.then(() => {
        const reserved = [...reservations.values()].reduce((sum, value) => sum + value, 0);
        if (reserved + input.reservedUsd > 0.003) return false;
        reservations.set(input.requestId, input.reservedUsd);
        return true;
      });
      queue = run.catch(() => {});
      return run;
    },
    async settleAIBudget(id, actual) { if (reservations.has(id)) reservations.set(id, Math.max(reservations.get(id), actual)); return true; },
    async releaseAIBudget(id) { return reservations.delete(id); }
  };
  const gateA = new AIBudgetGate({ operationsStore, logger: { warn() {} }, now });
  const gateB = new AIBudgetGate({ operationsStore, logger: { warn() {} }, now });
  const [first, second] = await Promise.all([request(gateA), request(gateB)]);
  assert.equal([first, second].filter(item => item.allowed).length, 1);
  assert.equal([first, second].find(item => !item.allowed).reason, 'monthly_budget_exceeded');
});

test('configuração de limite malformada não é tratada como ausência de budget', async () => {
  const gate = createGate();
  const result = await request(gate, 'model-a', { ...config, monthlyBudgets: [{ provider: 'invalid', amountUsd: 10 }] });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'budget_config_invalid');
});

test('settlement reprecifica o modelo efetivo e marca uso desconhecido sem tarifa', async () => {
  let settlement;
  const operationsStore = {
    async reserveAIBudget() { return true; },
    async settleAIBudget(_requestId, actualUsd, metadata) { settlement = { actualUsd, ...metadata }; return true; }
  };
  const gate = new AIBudgetGate({ operationsStore, logger: { warn() {} }, now });
  const permit = await request(gate);
  assert.equal(permit.allowed, true);
  await permit.commit({ promptTokens: 100, completionTokens: 100 }, { provider: 'gemini', model: 'effective-unpriced-model' });
  assert.equal(settlement.model, 'effective-unpriced-model');
  assert.equal(settlement.usageUnknown, true);
  assert.ok(settlement.actualUsd > 0);
});

test('settlement usa a tarifa do modelo efetivo quando o provedor altera o identificador', async () => {
  let settlement;
  const operationsStore = {
    async reserveAIBudget() { return true; },
    async settleAIBudget(_requestId, actualUsd, metadata) { settlement = { actualUsd, ...metadata }; return true; }
  };
  const aiConfig = {
    ...config,
    pricingRates: [...config.pricingRates, { provider: 'gemini', model: 'effective-model', inputUsdPerMillion: 20, outputUsdPerMillion: 20 }]
  };
  const gate = new AIBudgetGate({ operationsStore, logger: { warn() {} }, now });
  const permit = await request(gate, 'model-a', aiConfig);
  await permit.commit({ promptTokens: 100, completionTokens: 100 }, { provider: 'gemini', model: 'effective-model' });
  assert.equal(settlement.model, 'effective-model');
  assert.equal(settlement.usageUnknown, false);
  assert.ok(settlement.actualUsd > permit.reservedUsd);
});

test('falha de provedor torna a reserva permanentemente desconhecida até reconciliação', async () => {
  let settlement;
  const operationsStore = {
    async reserveAIBudget() { return true; },
    async settleAIBudget(_requestId, actualUsd, metadata) { settlement = { actualUsd, ...metadata }; return true; }
  };
  const gate = new AIBudgetGate({ operationsStore, logger: { warn() {} }, now });
  const permit = await request(gate);
  assert.equal(await permit.markUnknown({ provider: 'gemini', model: 'model-a' }), true);
  assert.equal(settlement.model, 'model-a');
  assert.equal(settlement.usageUnknown, true);
});

test('budget por provedor/modelo só restringe o modelo configurado', async () => {
  const gate = createGate();
  const aiConfig = { ...config, monthlyBudgets: [{ provider: 'gemini', model: 'model-a', amountUsd: 0.0005 }] };
  assert.equal((await request(gate, 'model-a', aiConfig)).reason, 'monthly_budget_exceeded');
  assert.equal((await request(gate, 'model-b', aiConfig)).allowed, true);
});

test('tarifa ausente bloqueia quando um budget aplicável existe', async () => {
  const gate = createGate();
  const result = await request(gate, 'sem-preco');
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'budget_rate_missing');
});

test('falha ao consultar telemetria persistida bloqueia chamada em modo fail-closed', async () => {
  const gate = createGate({ fail: new Error('Supabase fora do ar') });
  const result = await request(gate);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'budget_usage_unavailable');
});

test('histórico de custo desconhecido ou erro do provedor bloqueia budget afetado', async () => {
  const unknownUsage = createGate({ rows: [{ created_at: '2026-11-05T00:00:00Z', provider: 'gemini', model: 'model-a', prompt_tokens: 0, completion_tokens: 0, success: false }] });
  assert.equal((await request(unknownUsage)).reason, 'budget_usage_unknown');

  const missingRate = createGate({ rows: [{ created_at: '2026-11-05T00:00:00Z', provider: 'openai', model: 'old-model', prompt_tokens: 5, completion_tokens: 5, success: true }] });
  assert.equal((await request(missingRate)).reason, 'budget_rate_missing_for_usage');
});

test('linha mensal malformada não pode ser interpretada como custo zero', async () => {
  const gate = createGate({ rows: [{ created_at: '2026-11-05T00:00:00Z', provider: 'gemini', model: 'model-a', prompt_tokens: null, completion_tokens: 5, success: true }] });
  assert.equal((await request(gate)).reason, 'budget_usage_invalid');
});

test('request_id persistido reconcilia reserva e custo real substitui reserva conservadora', async () => {
  let rows = [];
  const gate = createGate({ rows });
  const first = await request(gate);
  assert.equal(first.allowed, true);
  await first.commit({ promptTokens: 10, completionTokens: 5 });
  rows.push({ request_id: first.requestId, created_at: '2026-11-13T14:00:01Z', provider: 'gemini', model: 'model-a', prompt_tokens: 10, completion_tokens: 5, success: true });
  const second = await request(gate);
  assert.equal(second.allowed, true);
});
