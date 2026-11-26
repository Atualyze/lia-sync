import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TenantStore, resolveTenantFromRequest } from './store.mjs';

test('TenantStore cria, lista, atualiza e protege subconta default', () => {
  const tmpFile = path.join(os.tmpdir(), `lia-tenants-${Date.now()}.json`);
  const store = new TenantStore(tmpFile).load();

  assert.equal(store.list().length, 1);
  assert.equal(store.get('default').id, 'default');

  const created = store.upsert({
    id: 'clinica-sorriso',
    name: 'Clínica Sorriso',
    whatsappProvider: 'ghl',
    knowledgeUrl: 'https://docs.google.com/document/d/123',
  });
  assert.equal(created.id, 'clinica-sorriso');
  assert.equal(created.whatsappProvider, 'ghl');
  assert.equal(store.list().length, 2);

  // Recarrega do disco
  const reloaded = new TenantStore(tmpFile).load();
  assert.equal(reloaded.get('clinica-sorriso')?.name, 'Clínica Sorriso');

  // Não permite remover default
  assert.equal(reloaded.remove('default'), false);
  assert.equal(reloaded.remove('clinica-sorriso'), true);

  fs.rmSync(tmpFile, { force: true });
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
