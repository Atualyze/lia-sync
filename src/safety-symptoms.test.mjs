import test from 'node:test';
import assert from 'node:assert/strict';
import { isHighRiskSymptom, isEmergency } from './safety.mjs';
import { decidirModeloPorContexto } from './model-router.mjs';

const CASOS_ALTO_RISCO = [
  'meu cachorro está sangrando',
  'ele comeu veneno de rato',
  'a gata teve uma convulsão',
  'o cão foi atropelado',
  'ele desmaiou agora',
  'não respira direito',
  'vomitou com sangue',
  'a cachorra não consegue levantar',
  'acho que ele está intoxicado'
];

for (const texto of CASOS_ALTO_RISCO) {
  test(`sintoma de alto risco detectado: "${texto}"`, () => {
    assert.equal(isHighRiskSymptom(texto), true);
    assert.equal(isEmergency(texto), true);
  });

  test(`sintoma de alto risco nunca vai para flash-lite: "${texto}"`, () => {
    const r = decidirModeloPorContexto({ userText: texto, configuredModel: 'gemini-3.8-flash' });
    assert.notEqual(r.model, 'gemini-2.5-flash-lite');
    assert.equal(r.escalate, true);
  });
}

test('mensagem comum continua indo para flash-lite', () => {
  const r = decidirModeloPorContexto({ userText: 'qual o horário de vocês?' });
  assert.equal(r.model, 'gemini-2.5-flash-lite');
});
