import test from 'node:test';
import assert from 'node:assert/strict';
import { authCache } from './dashboard.mjs';

const baseConfig = {
  webhookToken: 'machine-secret',
  supabaseUrl: 'https://project.supabase.co',
  supabaseKey: 'publishable-key',
  dashboardRoles: ['admin', 'operator', 'viewer']
};
const request = token => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

test('authCache não aceita WEBHOOK_TOKEN como autenticação humana', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false }; };
  try {
    const auth = authCache();
    assert.deepEqual(await auth(request('machine-secret'), { ...baseConfig, supabaseUrl: '', supabaseKey: '' }), { ok: false, status: 503, reason: 'supabase_not_configured' });
    assert.deepEqual(await auth(request('machine-secret'), baseConfig), { ok: false, status: 401, reason: 'invalid_token' });
    assert.deepEqual(await auth(request(''), baseConfig), { ok: false, status: 401, reason: 'missing_token' });
    assert.equal(calls, 1, 'a chave de máquina é submetida ao validador JWT, nunca tratada como login');
  } finally { globalThis.fetch = originalFetch; }
});

test('authCache retorna identidade e papel de perfil Supabase ativo', async () => {
  const originalFetch = globalThis.fetch;
  let profile = { id: 'user-1', active: true, role: 'operator' };
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-1' }) };
    return { ok: true, json: async () => [profile] };
  };
  try {
    const auth = authCache();
    assert.deepEqual(await auth(request('human-jwt'), baseConfig), { ok: true, userId: 'user-1', role: 'operator' });
    assert.equal(calls.length, 2);
    profile = { id: 'user-1', active: false, role: 'operator' };
    assert.deepEqual(await auth(request('inactive-jwt'), baseConfig), { ok: false, status: 403, reason: 'profile_inactive_or_role_not_allowed' });
    profile = { id: 'user-1', active: true, role: 'owner' };
    assert.deepEqual(await auth(request('unknown-role-jwt'), baseConfig), { ok: false, status: 403, reason: 'profile_inactive_or_role_not_allowed' });
    profile = { active: true, role: 'admin' };
    assert.deepEqual(await auth(request('missing-id-jwt'), baseConfig), { ok: false, status: 403, reason: 'profile_inactive_or_role_not_allowed' });
  } finally { globalThis.fetch = originalFetch; }
});
