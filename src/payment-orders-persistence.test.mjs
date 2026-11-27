import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InfinitePayOrderStore } from './tools/gerenciar_cobranca_pagamento.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lia-orders-')), 'orders.json');

test('pedidos são gravados de forma atômica (sem arquivo .tmp residual) e recarregados', () => {
  const file = tmpFile();
  const store = new InfinitePayOrderStore(file);
  store.recordOrder({ orderNsu: 'LIA1', amountCents: 1000 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n => n.endsWith('.tmp')), []);
  const reloaded = new InfinitePayOrderStore(file);
  assert.equal(reloaded.getOrder('LIA1').amountCents, 1000);
});

test('mais de 500 pedidos continuam persistidos', () => {
  const file = tmpFile();
  const store = new InfinitePayOrderStore(file);
  for (let i = 0; i < 600; i += 1) store.recordOrder({ orderNsu: `LIA${i}`, amountCents: 100 });
  const reloaded = new InfinitePayOrderStore(file);
  assert.ok(reloaded.getOrder('LIA0'));
  assert.ok(reloaded.getOrder('LIA599'));
});

test('arquivo corrompido é preservado como .corrupt-* em vez de sobrescrito', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ não é json');
  const originalError = console.error;
  console.error = () => {};
  try {
    const store = new InfinitePayOrderStore(file);
    store.recordOrder({ orderNsu: 'LIA2', amountCents: 500 });
  } finally {
    console.error = originalError;
  }
  const names = fs.readdirSync(path.dirname(file));
  const corrupt = names.find(n => n.includes('.corrupt-'));
  assert.ok(corrupt, 'deve preservar o arquivo corrompido');
  assert.equal(fs.readFileSync(path.join(path.dirname(file), corrupt), 'utf8'), '{ não é json');
  assert.equal(new InfinitePayOrderStore(file).getOrder('LIA2').amountCents, 500);
});
