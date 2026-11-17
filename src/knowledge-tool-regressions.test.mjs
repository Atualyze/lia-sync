import test from 'node:test';
import assert from 'node:assert/strict';
import { toolConsultarBaseConhecimento } from './tools/consultar_base_conhecimento.mjs';
import { isClientToolAllowed } from './tools/index.mjs';
import { formatOutgoingMessage } from './core/format.mjs';

test('ferramenta de conhecimento não consulta FAQ explicitamente desativada', async () => {
  const result = await toolConsultarBaseConhecimento.execute(
    { termo: 'marcador exclusivo' },
    { actor: 'client', botConfig: { knowledge: { faq: [{ keys: ['marcador exclusivo'], answer: 'resposta que não deve aparecer', enabled: false }] } } }
  );
  assert.equal(result.found, false);
  assert.doesNotMatch(JSON.stringify(result), /resposta que não deve aparecer/);
});

test('ferramenta de conhecimento retorna contexto relevante da base vinculada', async () => {
  const result = await toolConsultarBaseConhecimento.execute(
    { termo: 'sincronizar pedidos e cobrança' },
    {
      actor: 'client',
      session: { supportModeEnabled: true, knowledgeBaseId: 'clubinho-homevet' }
    }
  );
  assert.equal(result.found, true);
  assert.ok(result.resposta.length <= 6500);
});

test('cliente não pode alterar CRM diretamente', () => {
  assert.equal(isClientToolAllowed('atualizar_dados_crm'), false);
  assert.equal(isClientToolAllowed('consultar_base_conhecimento'), true);
});

test('cliente sem base vinculada não recebe dossiê de outro cliente por busca lexical', async () => {
  const result = await toolConsultarBaseConhecimento.execute(
    { termo: 'Clubinho HomeVet CRM sincronização' },
    { actor: 'client', session: { supportModeEnabled: false } }
  );
  assert.notEqual(result.base, 'MANUAL DE CONHECIMENTO & SUPORTE OPERACIONAL - CLUBINHO HOMEVET (CRM + LANDING PAGE)');
});

test('saída do WhatsApp remove travessão longo e preserva destaque', () => {
  const result = formatOutgoingMessage('Status — *Operacional*\n- Próximo passo: confirmar');
  assert.doesNotMatch(result, /—/);
  assert.match(result, /\*Operacional\*/);
  assert.match(result, /• Próximo passo:/);
});
