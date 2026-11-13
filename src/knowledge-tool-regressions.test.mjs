import test from 'node:test';
import assert from 'node:assert/strict';
import { toolConsultarBaseConhecimento } from './tools/consultar_base_conhecimento.mjs';

test('ferramenta de conhecimento não consulta FAQ explicitamente desativada', async () => {
  const result = await toolConsultarBaseConhecimento.execute(
    { termo: 'marcador exclusivo' },
    { actor: 'client', botConfig: { knowledge: { faq: [{ keys: ['marcador exclusivo'], answer: 'resposta que não deve aparecer', enabled: false }] } } }
  );
  assert.equal(result.found, false);
  assert.doesNotMatch(JSON.stringify(result), /resposta que não deve aparecer/);
});
