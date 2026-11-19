import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCognitionProtocol } from './cognition.mjs';

test('protocolo orienta a Lia a verificar intenção, contexto, evidência e autorização', () => {
  const prompt = buildCognitionProtocol();
  for (const section of [
    'INTENÇÃO ATUAL',
    'CONTEXTO',
    'FATOS E EVIDÊNCIAS',
    'AUTORIZAÇÃO E RISCO',
    'VERIFICAÇÃO',
    'Não exponha cadeia de pensamento'
  ]) {
    assert.ok(prompt.includes(section), `faltou a diretriz: ${section}`);
  }
});

test('protocolo mantém a mesma regra de decisão no Copiloto e no atendimento', () => {
  const owner = buildCognitionProtocol({ isOwner: true });
  const client = buildCognitionProtocol({ isOwner: false });
  assert.ok(owner.includes('responsável no chat interno'));
  assert.ok(client.includes('cliente no atendimento'));
  assert.ok(owner.includes('Uma resposta vaga'));
  assert.ok(client.includes('Uma resposta vaga'));
});
