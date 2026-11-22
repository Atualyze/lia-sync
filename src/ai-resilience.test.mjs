import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearModelCapabilities,
  getModelCapabilities,
  learnModelCapability,
  extractMessageContent,
  extractJsonFromReasoning,
  applyReasoningControls,
  buildProviderCandidateModels,
  computeAttemptTimeoutMs
} from './ai/resilience.mjs';
import { call } from './ai/call.mjs';
import { config } from './config.mjs';
import { opened, failures } from './ai/state.mjs';

test('getModelCapabilities e learnModelCapability aprendem capacidades em runtime', () => {
  clearModelCapabilities();
  const groqOss = getModelCapabilities('groq', 'openai/gpt-oss-20b');
  assert.equal(groqOss.isReasoning, true);
  assert.equal(groqOss.supportsResponseFormat, false);

  const nimNemotron = getModelCapabilities('nvidia', 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.equal(nimNemotron.isReasoning, true);
  assert.equal(nimNemotron.supportsThinkingToggle, true);

  const customModel = getModelCapabilities('meu_provedor', 'custom-v2');
  assert.equal(customModel.supportsNativeTools, true);
  learnModelCapability('meu_provedor', 'custom-v2', { supportsNativeTools: false, isReasoning: true });
  const updated = getModelCapabilities('meu_provedor', 'custom-v2');
  assert.equal(updated.supportsNativeTools, false);
  assert.equal(updated.isReasoning, true);
});

test('extractMessageContent suporta string, array de blocos e output_text', () => {
  assert.equal(extractMessageContent({ content: '  Olá!  ' }), 'Olá!');
  assert.equal(
    extractMessageContent({ content: [{ type: 'text', text: 'Linha 1' }, { type: 'text', text: 'Linha 2' }] }),
    'Linha 1\nLinha 2'
  );
  assert.equal(extractMessageContent({ output_text: 'Resposta direta' }), 'Resposta direta');
  assert.equal(
    extractJsonFromReasoning({ reasoning_content: 'pensando... {"reply":"Oi!","intent":"saudacao"}' }),
    '{"reply":"Oi!","intent":"saudacao"}'
  );
});

test('applyReasoningControls aplica parâmetro correto por família de provedor', () => {
  const groqBody = applyReasoningControls({ model: 'openai/gpt-oss-20b' }, { provider: 'groq', model: 'openai/gpt-oss-20b' });
  assert.equal(groqBody.reasoning_effort, 'low');

  const nimBody = applyReasoningControls({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b' }, { provider: 'nvidia', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' });
  assert.deepEqual(nimBody.chat_template_kwargs, { enable_thinking: false });

  const orBody = applyReasoningControls({ model: 'openrouter/free' }, { provider: 'openrouter', model: 'openrouter/free' });
  assert.deepEqual(orBody.reasoning, { effort: 'low' });
});

test('buildProviderCandidateModels inclui rede de segurança sem duplicatas e respeita openrouterFreeOnly', () => {
  const groqModels = buildProviderCandidateModels({ provider: 'groq', primaryModel: 'openai/gpt-oss-20b' });
  assert.deepEqual(groqModels, ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);

  const nimModels = buildProviderCandidateModels({ provider: 'nvidia', primaryModel: 'nvidia/nemotron-3.5-lightning-30b-a3b' });
  assert.deepEqual(nimModels, ['nvidia/nemotron-3.5-lightning-30b-a3b', 'meta/llama-3.3-70b-instruct']);

  const orModels = buildProviderCandidateModels({
    provider: 'openrouter',
    primaryModel: 'openrouter/free',
    configuredFallbacks: ['openai/gpt-4o', 'qwen/qwen3:free'],
    openrouterFreeOnly: true
  });
  assert.deepEqual(orModels, ['openrouter/free', 'qwen/qwen3:free']);
});

test('computeAttemptTimeoutMs limita tentativa intermediária a 15s e preserva tempo restante na última', () => {
  assert.equal(computeAttemptTimeoutMs({ remainingMs: 30000, providerTimeoutMs: 30000, hasMoreCandidates: true }), 15000);
  assert.equal(computeAttemptTimeoutMs({ remainingMs: 25000, providerTimeoutMs: 30000, hasMoreCandidates: false }), 25000);
});

test('call("groq") faz fallback automático intra-provedor em empty_reply para llama-3.3-70b-versatile', async () => {
  clearModelCapabilities();
  opened.clear();
  failures.clear();
  const prevKey = config.groqKey;
  const prevFetch = globalThis.fetch;
  config.groqKey = 'gsk_test_fake_key_1234567890';
  const calledModels = [];

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calledModels.push(body.model);
    if (body.model === 'openai/gpt-oss-20b') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '', reasoning: 'pensando sem fechar resposta' } }] })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: body.model,
        choices: [{ message: { content: '{"reply":"Respondido pelo fallback intra-provedor!","intent":"outro"}' } }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }
      })
    };
  };

  try {
    const res = await call('groq', {
      system: 'Você é a Lia.',
      history: [],
      userText: 'Olá',
      fixedModel: 'openai/gpt-oss-20b',
      deadline: Date.now() + 20000
    });
    assert.ok(res);
    assert.equal(res.model, 'llama-3.3-70b-versatile');
    assert.ok(res.raw.includes('Respondido pelo fallback intra-provedor!'));
    assert.ok(calledModels.includes('openai/gpt-oss-20b'));
    assert.ok(calledModels.includes('llama-3.3-70b-versatile'));
  } finally {
    config.groqKey = prevKey;
    globalThis.fetch = prevFetch;
  }
});
