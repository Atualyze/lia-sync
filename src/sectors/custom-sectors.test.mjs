import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CustomSectorStore } from './custom-sectors.mjs';

test('CustomSectorStore cria, edita, persiste e remove setores customizados', () => {
  const tmpFile = path.join(os.tmpdir(), `lia-sectors-${Date.now()}.json`);
  const store = new CustomSectorStore(tmpFile).load();

  assert.equal(store.list().length, 10);

  const created = store.upsert({
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

  const reloaded = new CustomSectorStore(tmpFile).load();
  assert.equal(reloaded.list().length, 11);
  assert.equal(reloaded.remove('parcerias'), true);
  assert.equal(reloaded.list().length, 10);

  fs.rmSync(tmpFile, { force: true });
});
