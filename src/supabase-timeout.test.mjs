import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseRestClient } from './supabase-runtime.mjs';

test('Supabase REST interrompe requisição no timeout configurado', async () => {
  const originalFetch = globalThis.fetch;
  const client = new SupabaseRestClient({ url: 'https://supabase.invalid', key: 'test-key', timeoutMs: 1000 });
  const keepAlive = setTimeout(() => {}, 1100);
  globalThis.fetch = (_url, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    await assert.rejects(client.select('contacts', 'select=id&limit=1'), error => error.name === 'TimeoutError');
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = originalFetch;
  }
});
