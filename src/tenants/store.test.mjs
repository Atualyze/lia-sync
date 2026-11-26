import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TenantStore, resolveTenantFromRequest } from './store.mjs';

test('TenantStore cria, lista, atualiza e protege subconta default (e suporta Supabase client)', async () => {
  const tmpFile = path.join(os.tmpdir(), `lia-tenants-${Date.now()}.json`);
  const store = await new TenantStore(tmpFile).load();

  assert.equal(store.list().length, 1);
  assert.equal(store.get('default').id, 'default');

  const created = await store.upsert({
    id: 'clinica-sorriso',
    name: 'Clínica Sorriso',
    whatsappProvider: 'ghl',
    knowledgeUrl: 'https://docs.google.com/document/d/123',
  });
  assert.equal(created.id, 'clinica-sorriso');
  assert.equal(created.whatsappProvider, 'ghl');
  assert.equal(store.list().length, 2);

  const reloaded = await new TenantStore(tmpFile).load();
  assert.equal(reloaded.get('clinica-sorriso')?.name, 'Clínica Sorriso');
  assert.equal(await reloaded.remove('default'), false);
  assert.equal(await reloaded.remove('clinica-sorriso'), true);

  fs.rmSync(tmpFile, { force: true });

  // Teste com mock de Supabase client (sem arquivo local)
  let savedRow = null;
  const mockClient = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: savedRow ? { payload: savedRow.payload } : null, error: null }) }) }),
      upsert: async (row) => { savedRow = row; return { error: null }; },
    }),
  };
  const dbStore = await new TenantStore(tmpFile, { client: mockClient }).load();
  await dbStore.upsert({ id: 'clinica-db', name: 'Clínica DB', whatsappProvider: 'manychat' });
  assert.equal(savedRow.key, 'lia_tenants');
  assert.equal(fs.existsSync(tmpFile), false);
});

test('resolveTenantFromRequest extrai tenantId da URL ou header', () => {
  assert.equal(
    resolveTenantFromRequest({ headers: {} }, new URL('http://localhost/webhook/ghl/clinica-a')),
    'clinica-a'
  );
  assert.equal(
    resolveTenantFromRequest({ headers: { 'x-tenant-id': 'loja-b' } }, new URL('http://localhost/api/dashboard/state')),
    'loja-b'
  );
  assert.equal(
    resolveTenantFromRequest({ headers: {} }, new URL('http://localhost/webhook/manychat')),
    'default'
  );
});
