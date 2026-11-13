import test from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;

function restoreEnvAfter(t, names) {
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
}

function mockFetchSequence(responses) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : null,
      headers: init?.headers || {}
    });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.status && r.status !== 200) {
      return new Response(JSON.stringify({ error: { message: `HTTP ${r.status}` } }), { status: r.status });
    }
    return new Response(JSON.stringify(r.json), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return calls;
}

const geminiOk = {
  json: {
    candidates: [
      {
        content: {
          parts: [
            {
              text: '{"reply":"Olá, tudo bem? Como posso te ajudar?","intent":"outro","red_flags":false,"handoff":false,"handoff_reason":null,"collected":{}}'
            }
          ]
        },
        finishReason: 'STOP'
      }
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
  }
};

test('fallback: flash-lite com 503 cai para flash subsequente', async (t) => {
  restoreEnvAfter(t, ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'QWEN_API_KEY', 'QWEN_BASE_URL', 'OPENAI_API_KEY']);
  process.env.GEMINI_API_KEY = 'test_gemini_key_123';
  process.env.OPENROUTER_API_KEY = 'test_openrouter_key';
  process.env.QWEN_API_KEY = 'test_qwen_key';
  process.env.QWEN_BASE_URL = 'https://qwen.test/v1';
  process.env.OPENAI_API_KEY = '';
  const calls = mockFetchSequence([{ status: 503 }, geminiOk]);
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const { askAI } = await import('./ai.mjs');
  const r = await askAI({
    userText: 'oi',
    botConfig: {
      ai: {
        activeProvider: 'gemini',
        activeModel: 'gemini-3.8-flash',
        autoRouting: true
      }
    },
    system: 'Você é a Lia.',
    history: []
  });

  assert.ok(r);
  assert.equal(r.reply, 'Olá, tudo bem? Como posso te ajudar?');
  assert.ok(calls.length >= 2, 'Deveria tentar o primeiro e cair para o segundo modelo');
  assert.match(calls[0].url, /gemini-3\.5-flash-lite/);
  assert.match(calls[1].url, /gemini/);
});

test('openrouter: nunca recebe ID de modelo do Gemini', async (t) => {
  restoreEnvAfter(t, ['GEMINI_API_KEY', 'OPENROUTER_API_KEY']);
  process.env.GEMINI_API_KEY = '';
  process.env.OPENROUTER_API_KEY = 'test_openrouter_key';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : null
    });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"reply":"Tudo bem!","intent":"outro"}'
            }
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const { askAI } = await import('./ai.mjs');
  await askAI({
    userText: 'qual seu nome?',
    botConfig: {
      ai: {
        activeProvider: 'openrouter',
        activeModel: 'nvidia/nemotron-3.5-lightning:free'
      }
    },
    system: 'Você é a Lia.',
    history: []
  });

  if (calls.length > 0) {
    const sentModel = calls[0].body?.model || '';
    assert.equal(sentModel.startsWith('gemini'), false, 'OpenRouter não deve receber IDs gemini-*');
  }
});

test('Qwen tenta até três reservas configuradas dentro do mesmo deadline', async (t) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (calls.length === 1) return new Response(JSON.stringify({ error: { message: 'HTTP 503' } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"reserva ok","intent":"outro"}' } }], usage: {} }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const { askAI } = await import('./ai.mjs');
  const result = await askAI({
    system: 'Você é Lia.', history: [], userText: 'Preciso de uma resposta detalhada.',
    botConfig: { ai: { activeProvider: 'qwen', activeModel: 'qwen-primary', fallbackModels: ['qwen-backup-1', 'qwen-backup-2', 'qwen-backup-3'], autoRouting: false } }
  });
  assert.equal(result?.reply, 'reserva ok');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.model, 'qwen-primary');
  assert.equal(calls[1].body.model, 'qwen-backup-1');
});

test('OpenRouter devolve chamadas de ferramenta nativas normalizadas', async (t) => {
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'consultar_web', arguments: '{"query":"cotação do dólar hoje"}' } }] } }], usage: {} }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const { askAI } = await import('./ai.mjs');
  const result = await askAI({
    system: 'Você é Lia.', history: [], userText: 'Pesquise cotação do dólar hoje.',
    botConfig: { ai: { activeProvider: 'openrouter', activeModel: 'provider/model', enableToolCalling: true, autoRouting: false } }
  });
  assert.ok(requestBody.tools.some(tool => tool.function?.name === 'consultar_web'));
  assert.equal(result?.tool_calls?.[0]?.name, 'consultar_web');
  assert.equal(result?.tool_calls?.[0]?.args?.query, 'cotação do dólar hoje');
});

test('budget atingido bloqueia a chamada antes de qualquer requisição ao provedor', async (t) => {
  restoreEnvAfter(t, ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'QWEN_API_KEY', 'OPENAI_API_KEY']);
  process.env.GEMINI_API_KEY = 'test_gemini_key_123';
  process.env.OPENROUTER_API_KEY = '';
  process.env.QWEN_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  const calls = mockFetchSequence([geminiOk]);
  t.after(() => { globalThis.fetch = realFetch; });
  const attemptedModels = [];
  const { askAI } = await import('./ai.mjs');
  const result = await askAI({
    system: 'Você é a Lia.', history: [], userText: 'oi',
    botConfig: { ai: { activeProvider: 'gemini', activeModel: 'gemini-3.8-flash', autoRouting: false } },
    budgetGate: { async acquire({ model }) { attemptedModels.push(model); return { allowed: false, reason: 'monthly_budget_exceeded' }; } }
  });
  assert.equal(result, null);
  assert.ok(attemptedModels.length > 0);
  assert.equal(calls.length, 0);
});

test('askAI liquida o budget pelo modelo efetivo reportado pelo OpenRouter', async (t) => {
  restoreEnvAfter(t, ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'QWEN_API_KEY', 'OPENAI_API_KEY']);
  process.env.GEMINI_API_KEY = '';
  process.env.OPENROUTER_API_KEY = 'test_openrouter_key';
  process.env.QWEN_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'vendor/effective-model',
    choices: [{ message: { content: '{"reply":"ok","intent":"outro"}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  t.after(() => { globalThis.fetch = realFetch; });

  let committed;
  const { askAI } = await import('./ai.mjs');
  const result = await askAI({
    system: 'Você é Lia.', history: [], userText: 'oi',
    botConfig: { ai: { activeProvider: 'openrouter', activeModel: 'vendor/requested-model', autoRouting: false } },
    budgetGate: { async acquire() { return { allowed: true, requestId: '1287cb82-3d53-4e1b-9b6f-3b7636472dc5', async commit(tokens, model) { committed = { tokens, model }; return true; } }; } }
  });

  assert.equal(result?.reply, 'ok');
  assert.equal(committed?.model?.provider, 'openrouter');
  assert.equal(committed?.model?.model, 'vendor/effective-model');
});
