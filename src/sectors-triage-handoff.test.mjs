import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CustomSectorStore, sanitizeSectorId } from './sectors/custom-sectors.mjs';
import { classificarSetorPorTexto, resolverSetorPorCategoria } from './triage-router.mjs';
import { toolTransferirSetor } from './tools/transferir_setor.mjs';

test('sanitizeSectorId normaliza acentos NFD e espaços com hífen', () => {
  assert.equal(sanitizeSectorId('Comercial / Vendas'), 'comercial-vendas');
  assert.equal(sanitizeSectorId('Pós-atendimento & Reputação'), 'pos-atendimento-reputacao');
  assert.equal(sanitizeSectorId('Ação'), 'acao');
});

test('CustomSectorStore usa client.select e client.upsert do REST client sem chamar .from()', async () => {
  let savedPayload = null;
  const mockClient = {
    enabled: true,
    async select() {
      return [{
        payload: {
          sectors: [{ id: 'financeiro', name: 'Financeiro VIP', handoffEnabled: true, responsiblePhone: '5585999991111', isActive: true }]
        }
      }];
    },
    async upsert(_table, rows) {
      savedPayload = rows[0].payload;
    }
  };
  const store = new CustomSectorStore(path.join(os.tmpdir(), `sectors-${Date.now()}.json`), { client: mockClient });
  await store.load();
  assert.equal(store.list()[0].name, 'Financeiro VIP');
  const updated = await store.upsert({ id: 'suporte', name: 'Suporte N2', responsiblePhone: '(85) 98888-7777', keywords: ['erro', 'erro', 'bug'] });
  assert.equal(updated.responsiblePhone, '85988887777');
  assert.deepEqual(updated.keywords, ['erro', 'bug']);
  assert.ok(Array.isArray(savedPayload?.sectors));
});

test('classificarSetorPorTexto roteia corretamente casos ambíguos e novos setores', () => {
  const sectors = new CustomSectorStore().list();
  const cases = [
    ['meu pix não funciona', 'financeiro'],
    ['o boleto veio com problema', 'financeiro'],
    ['preciso de ajuda com a fatura', 'financeiro'],
    ['quero cancelar meu plano', 'ouvidoria'],
    ['quero remarcar minha consulta', 'agendamento'],
    ['valor da mensalidade', 'vendas']
  ];
  for (const [msg, expectedSectorId] of cases) {
    const res = classificarSetorPorTexto(msg, sectors, { responsible: 'Responsável', companyName: 'Empresa' });
    assert.equal(res.sectorId, expectedSectorId, `Mensagem "${msg}" esperava "${expectedSectorId}" mas obteve "${res.sectorId}"`);
  }
});

test('resolverSetorPorCategoria resolve IDs customizados como ouvidoria e agendamento', () => {
  const sectors = new CustomSectorStore().list();
  assert.equal(resolverSetorPorCategoria('ouvidoria', sectors)?.sectorId, 'ouvidoria');
  assert.equal(resolverSetorPorCategoria('agendamento', sectors)?.sectorId, 'agendamento');
  assert.equal(resolverSetorPorCategoria('triagem', sectors)?.sectorId, 'triagem');
});

test('transferir_para_setor valida setor ativo e aciona triggerHandoff com responsiblePhone', async () => {
  const sectors = new CustomSectorStore().list().map(s =>
    s.id === 'financeiro' ? { ...s, responsiblePhone: '5585999990000' } : s
  );
  const bad = await toolTransferirSetor.execute({ setor: 'inexistente', motivo: 'teste' }, { sectors });
  assert.equal(bad.success, false);
  assert.equal(bad.error, 'invalid_sector');

  let called = null;
  const ok = await toolTransferirSetor.execute(
    { setor: 'financeiro', motivo: 'Estorno de cobrança' },
    {
      sectors,
      triggerHandoff: async (args) => { called = args; }
    }
  );
  assert.equal(ok.success, true);
  assert.equal(ok.handoffExecuted, true);
  assert.equal(called?.sector?.id, 'financeiro');
  assert.equal(called?.responsiblePhone, '5585999990000');
});
