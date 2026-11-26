import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CustomSectorStore } from './custom-sectors.mjs';

test('CustomSectorStore cria, edita, persiste e remove setores customizados (e suporta Supabase client)', async () => {
  const tmpFile = path.join(os.tmpdir(), `lia-sectors-${Date.now()}.json`);
  const store = await new CustomSectorStore(tmpFile).load();

  assert.equal(store.list().length, 10);

  const created = await store.upsert({
    id: 'parcerias',
    name: 'Parcerias & Afiliados',
    description: 'Contato de novos parceiros comerciais.',
    keywords: 'parceria, afiliado, comissão',
    promptInstructions: 'Acolha com empatia e transfira imediatamente.',
    handoffEnabled: true,
    responsiblePhone: '5511999998888',
  });

  assert.equal(created.id, 'parcerias');
  assert.deepEqual(created.keywords, ['parceria', 'afiliado', 'comissão']);
  assert.equal(created.handoffEnabled, true);

  const reloaded = await new CustomSectorStore(tmpFile).load();
  assert.equal(reloaded.list().length, 11);
  assert.equal(await reloaded.remove('parcerias'), true);
  assert.equal(reloaded.list().length, 10);

  fs.rmSync(tmpFile, { force: true });

  // Teste com mock de Supabase client (sem arquivo local)
  let savedRow = null;
  const mockClient = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: savedRow ? { payload: savedRow.payload } : null, error: null }) }) }),
      upsert: async (row) => { savedRow = row; return { error: null }; },
    }),
  };
  const dbStore = await new CustomSectorStore(tmpFile, { client: mockClient }).load();
  await dbStore.upsert({ id: 'vip', name: 'Atendimento VIP', keywords: 'vip' });
  assert.equal(savedRow.key, 'lia_custom_sectors');
  assert.equal(fs.existsSync(tmpFile), false);
});
