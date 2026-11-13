import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key';
const originalFetch = globalThis.fetch;
const { listProviderModels } = await import('./ai/catalog.mjs');

test('catálogo não oferece embeddings, moderação ou transcrição como modelos de chat', async () => {
  let calls = 0;
  globalThis.fetch = async url => ({
    ok: true,
    json: async () => {
      calls++;
      if (calls === 1) {
        assert.match(String(url), /\/models$/);
        return { data: [
          { id: 'gpt-4o-mini', owned_by: 'openai' },
          { id: 'text-embedding-3-small', owned_by: 'openai' },
          { id: 'whisper-1', owned_by: 'openai' },
          { id: 'omni-moderation-latest', owned_by: 'openai' }
        ], has_more: true };
      }
      assert.match(String(url), /after=omni-moderation-latest/);
      return { data: [{ id: 'gpt-4.1-mini', owned_by: 'openai' }], has_more: false };
    }
  });
  try {
    const result = await listProviderModels('openai', { forceRefresh: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.models.map(model => model.id), ['gpt-4.1-mini', 'gpt-4o-mini']);
    assert.equal(result.truncated, false);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
