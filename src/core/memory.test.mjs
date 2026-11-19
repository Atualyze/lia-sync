import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from './memory.mjs';

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lia-memory-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MemoryStore(path.join(dir, 'memories.json'));
}

const embeddingResponse = () => ({
  ok: true,
  json: async () => ({ embedding: { values: [1, 0, 0] } })
});

test('memória: não chama API de embedding quando o escopo não possui memórias semânticas', async t => {
  const store = tempStore(t);
  store.remember({
    scopeKey: 'tenant:client-a',
    type: 'preference',
    content: 'Prefere respostas curtas e objetivas',
    importance: 0.9
  });
  let calls = 0;
  const result = await store.retrieveSemantic({
    scopeKey: 'tenant:client-a',
    query: 'respostas objetivas',
    apiKey: 'test-key',
    fetchImpl: async () => { calls += 1; throw new Error('não deveria consultar'); }
  });
  assert.equal(calls, 0);
  assert.equal(result.length, 1);
  assert.match(result[0].content, /respostas curtas/i);
});

test('memória: usa embedding para enriquecer a recuperação quando há dados semânticos', async t => {
  const store = tempStore(t);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return embeddingResponse(); };
  await store.rememberWithEmbedding({
    scopeKey: 'tenant:owner',
    type: 'preference',
    content: 'O responsável prefere respostas diretas, com conclusão primeiro',
    importance: 0.9
  }, { apiKey: 'test-key', fetchImpl });
  store.remember({
    scopeKey: 'tenant:owner',
    type: 'fact',
    content: 'O responsável está organizando o catálogo comercial',
    importance: 0.5
  });
  const result = await store.retrieveSemantic({
    scopeKey: 'tenant:owner',
    query: 'como estruturar uma resposta clara',
    apiKey: 'test-key',
    fetchImpl
  });
  assert.equal(calls, 2);
  assert.equal(result[0].type, 'preference');
});


test('memória: corrigir conteúdo atualiza o vetor semântico anterior', async t => {
  const store = tempStore(t);
  let vector = [1, 0, 0];
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ embedding: { values: vector } })
  });
  const saved = await store.rememberWithEmbedding({
    scopeKey: 'tenant:owner',
    type: 'project',
    content: 'Projeto antigo de atendimento',
    importance: 0.8
  }, { apiKey: 'test-key', fetchImpl });
  vector = [0, 1, 0];
  const corrected = await store.correctWithEmbedding({
    scopeKey: 'tenant:owner',
    idOrQuery: saved.memory.id,
    newContent: 'Projeto atualizado de automação',
    type: 'project'
  }, { apiKey: 'test-key', fetchImpl });
  assert.equal(corrected.updated, true);
  assert.deepEqual(corrected.memory.embedding, [0, 1, 0]);
  assert.match(corrected.memory.content, /atualizado/i);
});
