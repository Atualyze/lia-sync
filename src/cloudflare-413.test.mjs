import test from 'node:test';
import assert from 'node:assert/strict';

process.env.CLOUDFLARE_ACCOUNT_ID = 'test_account';
process.env.CLOUDFLARE_API_TOKEN = 'test_cloudflare_token';
process.env.GEMINI_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.QWEN_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const realFetch = globalThis.fetch;

test('Cloudflare reduz contexto após 413 e tenta o modelo de fallback', async (t) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (calls.length <= 2) return new Response(JSON.stringify({ error: { message: 'payload too large' } }), { status: 413 });
    return new Response(JSON.stringify({
      success: true,
      result: {
        response: '{"reply":"Resposta compactada","intent":"outro","red_flags":false,"handoff":false}',
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const { call } = await import('./ai/call.mjs');
  const result = await call('cloudflare', {
    system: 'instruções '.repeat(4000),
    history: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `mensagem ${i} `.repeat(400) })),
    userText: 'Preciso de ajuda',
    deadline: Date.now() + 15000,
    fixedModel: '@cf/test-primary',
    aiConfig: { activeProvider: 'cloudflare', activeModel: '@cf/test-primary', fallbackModels: ['cloudflare:@cf/test-backup'] },
    toolDeclarations: [{ name: 'consultar_web', description: 'Consulta a web', parameters: { type: 'object', properties: {} } }]
  });

  assert.equal(result?.model, '@cf/test-backup');
  assert.equal(calls.length, 3);
  assert.ok(JSON.stringify(calls[1].body).length < JSON.stringify(calls[0].body).length);
  assert.equal(calls[1].body.tools, undefined);
  assert.match(calls[2].url, /@cf\/test-backup/);
});
