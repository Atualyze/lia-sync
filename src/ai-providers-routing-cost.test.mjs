import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { CustomProviderStore } from './ai/custom-providers.mjs';
import { describeAIError } from './ai/errors.mjs';
import { providers, parseFallbackModel, getCircuitBreakers } from './ai/config.mjs';
import { summarizePersistentCalls } from './operations.mjs';

test('describeAIError traduz falhas HTTP/rede em diagnósticos claros sem vazar segredos', () => {
  const auth = describeAIError('openai', new Error('openai 401 - invalid api key sk-secret1234567890'), 'gpt-4o');
  assert.equal(auth.code, 'CREDENCIAIS_INVALIDAS');
  assert.ok(!auth.message.includes('sk-secret'));
  assert.ok(auth.quarantineMs >= 60_000);

  const credits = describeAIError('openrouter', new Error('openrouter 402 - Payment Required'), 'model-x');
  assert.equal(credits.code, 'SALDO_ESGOTADO');
  assert.equal(credits.isCreditExhausted, true);

  const rate = describeAIError('gemini', new Error('Gemini 429 rate limit'), 'gemini-2.5-flash');
  assert.equal(rate.code, 'LIMITE_REQUISICOES');
  assert.equal(rate.quarantineMs, 60_000);

  const net = describeAIError('groq', new Error('fetch failed ENOTFOUND api.groq.com'));
  assert.equal(net.code, 'REDE_INDISPONIVEL');
});

test('CustomProviderStore cadastra provedor OpenAI-compatible, mascara chave, integra no roteamento e na contingência', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-custom-prov-'));
  const filePath = path.join(dir, 'custom-providers.json');
  try {
    const store = new CustomProviderStore({ filePath, logger: { warn() {}, error() {} } });
    await store.load();

    const saved = await store.upsert({
      id: 'deepseek',
      name: 'DeepSeek Cloud',
      baseUrl: 'https://api.deepseek.com/v1/',
      apiKey: 'sk-deepseek-super-secret-999',
      defaultModel: 'deepseek-chat',
      inputUsdPerMillion: 0.27,
      outputUsdPerMillion: 1.10
    });
    assert.equal(saved.id, 'deepseek');
    assert.equal(saved.baseUrl, 'https://api.deepseek.com/v1');
    assert.match(saved.maskedKey, /^sk-d\*\*\*999$/);
    assert.equal(saved.apiKey, undefined);

    // Parse fallback prefix com provedor customizado
    const parsed = parseFallbackModel('deepseek:deepseek-reasoner');
    assert.deepEqual(parsed, { provider: 'deepseek', model: 'deepseek-reasoner' });

    // Aparece no circuit breaker e no roteamento de contingência respeitando ordem de fallbackModels
    const breakers = getCircuitBreakers();
    assert.equal(breakers.deepseek.configured, true);
    assert.equal(breakers.deepseek.isCustom, true);

    const routeOrder = providers({
      ai: {
        activeProvider: 'deepseek',
        activeModel: 'deepseek-chat',
        fallbackModels: ['openrouter:google/gemma-4-31b:free']
      }
    });
    assert.equal(routeOrder[0], 'deepseek');

    await store.remove('deepseek');
    assert.equal(getCircuitBreakers().deepseek, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('summarizePersistentCalls calcula custo de provedores customizados, modelos :free = $0 e projeção mensal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-cost-calc-'));
  const store = new CustomProviderStore({ filePath: path.join(dir, 'custom-providers.json'), logger: { warn() {}, error() {} } });
  try {
    await store.load();
    await store.upsert({
      id: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_test_1234567890',
      defaultModel: 'llama-3.3-70b-versatile',
      inputUsdPerMillion: 0.59,
      outputUsdPerMillion: 0.79
    });

    const now = new Date('2026-11-15T12:00:00Z'); // dia 15 de 30 -> projeção = 2x
    const rows = [
      {
        created_at: '2026-11-15T10:00:00Z',
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        total_tokens: 2_000_000,
        latency_ms: 420,
        success: true
      },
      {
        created_at: '2026-11-15T11:00:00Z',
        provider: 'openrouter',
        model: 'google/gemma-4-31b:free',
        prompt_tokens: 500_000,
        completion_tokens: 200_000,
        total_tokens: 700_000,
        latency_ms: 850,
        success: true
      }
    ];

    const summary = summarizePersistentCalls(rows, { pricingRates: [] }, now);
    assert.equal(summary.estimatedCost.complete, true);
    assert.equal(summary.estimatedCost.totalUsd, 1.38); // 0.59 + 0.79 + 0.00 (:free)
    assert.equal(summary.estimatedCost.byProviderCost.groq, 1.38);
    assert.equal(summary.estimatedCost.byProviderCost.openrouter, 0);
    assert.equal(summary.estimatedCost.dailyBurnRateUsd, 0.092);
    assert.equal(summary.estimatedCost.projectedMonthlyUsd, 2.76);
    assert.ok(summary.estimatedCost.avgCostPer1kCallsUsd > 0);
  } finally {
    await store.remove('groq').catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
