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
  assert.deepEqual((await store.listActiveForPhone('5588998340085')).map(item => item.text), ['Reunião A']);
  assert.deepEqual((await store.listActiveForPhone('558899834008')).map(item => item.text), []);
  assert.deepEqual((await store.listActiveForPhone('sim:5588998340085')), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('listActiveForPhone compara identificadores @lid integralmente', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-reminders-lid-'));
  const store = new ReminderStore(path.join(dir, 'reminders.json'));
  await store.load();
  await store.add({ phone: '123456789@lid', text: 'LID A', dueAt: '2026-11-26T17:00:00.000Z' });
  await store.add({ phone: '123456780@lid', text: 'LID B', dueAt: '2026-11-26T18:00:00.000Z' });
  assert.deepEqual((await store.listActiveForPhone('123456789@lid')).map(item => item.text), ['LID A']);
  await fs.rm(dir, { recursive: true, force: true });
});


test('listActiveForPhone consulta Supabase por telefone exato e pagina todos os resultados', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-reminders-supabase-pages-'));
  const queries = [];
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({
    id: 'remote-' + index,
    text: 'Lembrete ' + index,
    due_at: '2026-11-26T17:00:00.000Z',
    phone: '5588998340085',
    status: 'pending',
    created_at: new Date(Date.UTC(2026, 10, 25, 12, 0, index % 60)).toISOString()
  }));
  const secondPage = [{
    id: 'remote-last',
    text: 'Último lembrete',
    due_at: '2026-11-27T17:00:00.000Z',
    phone: '5588998340085',
    status: 'pending',
    created_at: '2026-11-25T13:00:00.000Z'
  }];
  const client = {
    enabled: true,
    async select(table, query) {
      queries.push({ table, query });
      return query.includes('offset=1000') ? secondPage : firstPage;
    }
  };
  const store = new ReminderStore(path.join(dir, 'reminders.json'), { client });
  await store.load();
  assert.equal(queries.length, 2, 'bootstrap deve carregar todas as páginas pendentes');
  assert.doesNotMatch(queries[0].query, /phone=eq/);
  assert.match(queries[1].query, /offset=1000/);
  const result = await store.listActiveForPhone('5588998340085');
  assert.equal(result.length, 1001);
  assert.equal(result.at(-1).text, 'Último lembrete');
  assert.equal(queries.length, 4);
  for (const request of queries.slice(2)) {
    assert.equal(request.table, 'reminders');
    assert.match(request.query, /phone=eq\.5588998340085/);
    assert.match(request.query, /status=eq\.pending/);
  }
  assert.match(queries[3].query, /offset=1000/);

  const allActive = await store.listAllActive();
  assert.equal(allActive.length, 1001);
  assert.equal(queries.length, 6);
  assert.doesNotMatch(queries[4].query, /phone=eq/);
  assert.match(queries[4].query, /status=eq\.pending/);
  assert.match(queries[5].query, /offset=1000/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('listActiveForPhone não devolve contagem parcial se consulta Supabase falhar', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-reminders-supabase-fail-'));
  const store = new ReminderStore(path.join(dir, 'reminders.json'));
  await store.load();
  await store.add({
    phone: '5588998340085',
    text: 'Registro local',
    dueAt: '2026-11-26T17:00:00.000Z'
  });
  store.client = {
    enabled: true,
    async select() { throw new Error('Supabase indisponível'); }
  };
  await assert.rejects(() => store.listActiveForPhone('5588998340085'), /Supabase indisponível/);
  await fs.rm(dir, { recursive: true, force: true });
});
