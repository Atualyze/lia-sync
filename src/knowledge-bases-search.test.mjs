import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatchingKnowledgeBaseSync, findGuidanceKnowledgeSync } from './knowledge-bases.mjs';

test('KB content search: finds sales_intelligence objection guide by body/section content', () => {
  const match = findGuidanceKnowledgeSync('achei o valor muito caro e vou pensar antes de fechar');
  assert.ok(match, 'Should match sales_intelligence guide by content');
  assert.equal(match.folder, 'sales_intelligence');
  assert.ok(match.content.length <= 3000, 'Snippet should respect maxChars');
});

test('KB content search: finds biblioteca_juridica by legal topic without filename words', () => {
  const match = findGuidanceKnowledgeSync('comprei online e quero exercer meu direito de arrependimento em 7 dias');
  assert.ok(match, 'Should match biblioteca_juridica guide by content');
  assert.equal(match.folder, 'biblioteca_juridica');
});

test('KB content search: avoids false positives on generic greetings', () => {
  const match = findMatchingKnowledgeBaseSync('oi tudo bem, preciso de atendimento');
  assert.equal(match, null);
  const guidance = findGuidanceKnowledgeSync('oi bom dia');
  assert.equal(guidance, null);
});

test('KB content search: never exposes copilot-only bases to client queries', () => {
  const clientMatch = findMatchingKnowledgeBaseSync('autoconhecimento operacoes lia sync painel copilot', undefined, { includeCopilotOnly: false });
  assert.notEqual(clientMatch?.id, 'lia-autoconhecimento-operacoes');
});
