import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { CustomProviderStore } from './ai/custom-providers.mjs';
import { describeAIError } from './ai/errors.mjs';
import { providers, available, parseFallbackModel, getCircuitBreakers, getRecentAIErrorSummary, providerDefaultModel } from './ai/config.mjs';
import { call } from './ai/call.mjs';
import { config } from './config.mjs';
import { validateBotConfig, DEFAULT_BOT_CONFIG, clone } from './admin-config.mjs';
import { lastErrors } from './ai/state.mjs';
import { summarizePersistentCalls } from './operations.mjs';
import { createFlow } from './flow.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';

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
      id: 'together',
      name: 'Together AI',
      baseUrl: 'https://api.together.xyz/v1',
      apiKey: 'tog_test_1234567890',
      defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      inputUsdPerMillion: 0.59,
      outputUsdPerMillion: 0.79
    });

    const now = new Date('2026-11-15T12:00:00Z'); // dia 15 de 30 -> projeção = 2x
    const rows = [
      {
        created_at: '2026-11-15T10:00:00Z',
        provider: 'together',
        model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
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
    assert.equal(summary.estimatedCost.byProviderCost.together, 1.38);
    assert.equal(summary.estimatedCost.byProviderCost.openrouter, 0);
    assert.equal(summary.estimatedCost.dailyBurnRateUsd, 0.092);
    assert.equal(summary.estimatedCost.projectedMonthlyUsd, 2.76);
    assert.ok(summary.estimatedCost.avgCostPer1kCallsUsd > 0);
  } finally {
    await store.remove('together').catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('Copiloto reporta o erro real das APIs de IA em vez de frase genérica e não dispara Pix não solicitado em saudação ("Bom dia")', async () => {
  const sessions = {};
  const store = {
    sessions,
    get(key) {
      if (!sessions[key]) sessions[key] = { phone: key, history: [], human: false };
      return sessions[key];
    },
    touch() {},
    markDirty() {}
  };

  // 1. Quando provedores de IA falham com erro técnico, o Copiloto exibe o diagnóstico real
  lastErrors.clear();
  lastErrors.set('gemini', {
    code: 'SALDO_ESGOTADO',
    message: 'Saldo ou créditos esgotados em gemini (gemini-2.5-flash).',
    model: 'gemini-2.5-flash',
    at: new Date().toISOString()
  });
  lastErrors.set('cloudflare', {
    code: 'TIMEOUT',
    message: 'Tempo limite excedido aguardando resposta de cloudflare (@cf/meta/llama-3.3-70b-instruct-fp8-fast).',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    at: new Date().toISOString()
  });

  const failingFlow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    isOwnerSender: p => p === OWNER_SELF_KEY,
    ai: {
      askAI: async () => null
    }
  });

  const errReply = await failingFlow.process({
    phone: OWNER_SELF_KEY,
    text: 'Oi',
    origin: 'owner'
  });

  assert.match(errReply, /Falha na comunicação com os provedores de IA/i);
  assert.match(errReply, /SALDO_ESGOTADO/);
  assert.match(errReply, /TIMEOUT/);
  assert.doesNotMatch(errReply, /Ainda não consegui entender com segurança/i);
  assert.doesNotMatch(errReply, /ainda não entendi bem o que você precisa/i);
  lastErrors.clear();

  // 2. Quando o responsável envia "Bom dia" e o modelo alucina uma tool_call de Pix,
  // a saudação pura suprime tool_calls não solicitadas e responde normalmente
  const self = store.get(OWNER_SELF_KEY);
  self.pendingPixRequest = {
    requestedAt: new Date().toISOString(),
    amount: null,
    description: ''
  };

  const greetingFlow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    isOwnerSender: p => p === OWNER_SELF_KEY,
    ai: {
      askAI: async () => ({
        reply: 'Bom dia, Tauan! Tudo ótimo por aqui. Como posso te ajudar hoje?',
        intent: 'saudacao',
        tool_calls: [{ name: 'gerenciar_cobranca_pagamento', args: { valor: null, descricao: '' } }]
      })
    }
  });

  const greetReply = await greetingFlow.process({
    phone: OWNER_SELF_KEY,
    text: 'Bom dia',
    origin: 'owner'
  });

  assert.match(greetReply, /Bom dia, Tauan/i);
  assert.doesNotMatch(greetReply, /argumentos recebidos não passaram pela validação/i);
  assert.doesNotMatch(greetReply, /para gerar a cobrança Pix/i);
});

test('NVIDIA NIM integrado como provedor nativo: roteamento, chamada OpenAI-compatible e validação de configuração', async () => {
  const prevKey = config.nvidiaKey;
  const prevBase = config.nvidiaBaseUrl;
  const prevFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedAuth = '';
  let capturedModel = '';

  try {
    config.nvidiaKey = 'nvapi-test-key-123456';
    config.nvidiaBaseUrl = 'https://integrate.api.nvidia.com/v1';

    assert.ok(available('nvidia'));
    assert.equal(providerDefaultModel('nvidia', { provider: 'gemini', model: 'gemini-2.5-flash', fallbackModels: [] }), 'meta/llama-3.3-70b-instruct');
    assert.deepEqual(parseFallbackModel('nvidia:meta/llama-3.3-70b-instruct'), {
      provider: 'nvidia',
      model: 'meta/llama-3.3-70b-instruct'
    });

    const breakers = getCircuitBreakers();
    assert.equal(breakers.nvidia?.configured, true);
    assert.equal(breakers.nvidia?.status, 'operacional');

    const cfg = clone(DEFAULT_BOT_CONFIG);
    cfg.ai.activeProvider = 'nvidia';
    cfg.ai.activeModel = 'meta/llama-3.3-70b-instruct';
    cfg.ai.fallbackModels = ['nvidia:deepseek-ai/deepseek-r1'];
    const validationErrors = validateBotConfig(cfg);
    assert.deepEqual(validationErrors, []);

    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedAuth = init?.headers?.Authorization || '';
      const body = JSON.parse(init?.body || '{}');
      capturedModel = body.model || '';
      return new Response(JSON.stringify({
        model: body.model,
        choices: [{ message: { content: JSON.stringify({ reply: 'Olá via NVIDIA NIM!', intent: 'outro', red_flags: false, handoff: false }) } }],
        usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const res = await call('nvidia', {
      system: 'Responda em JSON.',
      history: [],
      userText: 'Oi',
      fixedModel: 'meta/llama-3.3-70b-instruct',
      aiConfig: { activeProvider: 'nvidia', activeModel: 'meta/llama-3.3-70b-instruct' }
    });

    assert.equal(capturedUrl, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(capturedAuth, 'Bearer nvapi-test-key-123456');
    assert.equal(capturedModel, 'meta/llama-3.3-70b-instruct');
    assert.match(res.raw, /NVIDIA NIM/);

    // Quando o painel define Principal + Reservas sem Gemini, Gemini nunca entra na fila mesmo com chave configurada
    const prevGeminiKey = config.geminiKey;
    const prevGroqKey = config.groqKey;
    try {
      config.geminiKey = 'AIza-test-key-unused-for-chat';
      config.groqKey = 'gsk-test-key-123';
      const strictList = providers({
        ai: {
          activeProvider: 'groq',
          activeModel: 'llama-3.3-70b-versatile',
          fallbackModels: ['nvidia:meta/llama-3.3-70b-instruct']
        }
      });
      assert.deepEqual(strictList, ['groq', 'nvidia']);
      assert.equal(strictList.includes('gemini'), false);
    } finally {
      config.geminiKey = prevGeminiKey;
      config.groqKey = prevGroqKey;
    }
  } finally {
    config.nvidiaKey = prevKey;
    config.nvidiaBaseUrl = prevBase;
    globalThis.fetch = prevFetch;
  }
});
