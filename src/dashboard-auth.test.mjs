import test from 'node:test';
import assert from 'node:assert/strict';
import { authCache } from './dashboard.mjs';

const baseConfig = {
  webhookToken: 'machine-secret',
  supabaseUrl: 'https://project.supabase.co',
  supabaseKey: 'publishable-key',
  dashboardRoles: ['admin', 'operator']
};

const request = token => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

test('authCache aceita somente o WEBHOOK_TOKEN como auth server-to-server', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return { ok: false }; };
  try {
    const auth = authCache();
    assert.deepEqual(await auth(request('machine-secret'), { ...baseConfig, supabaseUrl: '', supabaseKey: '' }), { ok: true });
    assert.deepEqual(await auth(request('wrong-secret'), { ...baseConfig, supabaseUrl: '', supabaseKey: '' }), {
      ok: false, status: 503, reason: 'supabase_not_configured'
    });
    assert.deepEqual(await auth(request('machine-secret'), { ...baseConfig, webhookToken: '' }), { ok: false, status: 401, reason: 'invalid_token' });
    assert.equal(fetchCalls, 1, 'somente o token não configurado deve seguir para validação Supabase');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authCache continua exigindo JWT Supabase e profile humano ativo com role permitida', async () => {
  const originalFetch = globalThis.fetch;
  const profile = { active: true, role: 'operator' };
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-1' }) };
    return { ok: true, json: async () => [profile] };
  };
  try {
    const auth = authCache();
    assert.deepEqual(await auth(request('human-jwt'), baseConfig), { ok: true });
    assert.equal(calls.length, 2);
    profile.active = false;
    assert.deepEqual(await auth(request('inactive-jwt'), baseConfig), {
      ok: false, status: 403, reason: 'profile_inactive_or_role_not_allowed'
    });
    profile.active = true;
    profile.role = 'viewer';
    assert.deepEqual(await auth(request('wrong-role-jwt'), baseConfig), {
      ok: false, status: 403, reason: 'profile_inactive_or_role_not_allowed'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
