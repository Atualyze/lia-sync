import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReminderStore } from './reminders.mjs';

test('ReminderStore agenda e persiste lembretes em disco', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-reminders-'));
  const file = path.join(dir, 'reminders.json');
  const store = new ReminderStore(file);
  await store.load();
  const item = await store.add({ phone: '5511999998888', text: 'Retornar contato', dueAt: new Date(1700000060000).toISOString() });
  assert.ok(item?.id);
  assert.equal(store.reminders.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});


test('listActiveForPhone retorna somente lembretes pendentes do telefone autenticado exato', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-reminders-scope-'));
  const file = path.join(dir, 'reminders.json');
  const store = new ReminderStore(file, { now: () => Date.parse('2026-11-25T12:00:00.000Z') });
  await store.load();
  await store.add({ phone: '5588998340085', clientName: 'Contato A', text: 'Reunião A', dueAt: '2026-11-26T17:00:00.000Z' });
  await store.add({ phone: '5588998340086', clientName: 'Contato B', text: 'Reunião B', dueAt: '2026-11-26T18:00:00.000Z' });
  await store.add({ phone: 'sim:5588998340085', clientName: 'Contato A simulado', text: 'Simulação', dueAt: '2026-11-26T19:00:00.000Z' });
  assert.deepEqual(store.listActiveForPhone('5588998340085').map(item => item.text), ['Reunião A']);
  assert.deepEqual(store.listActiveForPhone('558899834008').map(item => item.text), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('listActiveForPhone compara identificadores @lid integralmente', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-reminders-lid-'));
  const store = new ReminderStore(path.join(dir, 'reminders.json'));
  await store.load();
  await store.add({ phone: '123456789@lid', text: 'LID A', dueAt: '2026-11-26T17:00:00.000Z' });
  await store.add({ phone: '123456780@lid', text: 'LID B', dueAt: '2026-11-26T18:00:00.000Z' });
  assert.deepEqual(store.listActiveForPhone('123456789@lid').map(item => item.text), ['LID A']);
  await fs.rm(dir, { recursive: true, force: true });
});
