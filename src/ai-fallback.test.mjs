import test from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;

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
  process.env.GEMINI_API_KEY = 'test_gemini_key_123';
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
