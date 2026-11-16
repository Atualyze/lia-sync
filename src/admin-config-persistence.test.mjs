import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdminConfigStore, clone, normalizeBotConfig } from './admin-config.mjs';
import { SupabaseAdminConfigStore } from './supabase-runtime.mjs';


test('publish com falha de flush local reverte estado (revision, active, draft, history)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-admin-publish-flush-'));
  try {
    const store = new AdminConfigStore(path.join(dir, 'bot-config.json'));
    await store.load();
    const before = { revision: store.revision, active: clone(store.active), draft: clone(store.draft), history: clone(store.history), updatedAt: store.updatedAt };
    store.draft.business.greeting = 'Mensagem de teste para publicação';
    const originalFlush = store.flush.bind(store);
    let fail = true;
    store.flush = async () => { if (fail) throw new Error('disco cheio'); return originalFlush(); };
    const result = await store.publish('test');
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /disco cheio|persistência/i);
    assert.equal(store.revision, before.revision);
    assert.deepEqual(store.active, before.active);
    assert.equal(store.updatedAt, before.updatedAt);
    assert.equal(store.history.length, before.history.length);
    // Com o flush recuperado, publish volta a funcionar.
    fail = false;
    const retry = await store.publish('test');
    assert.equal(retry.ok, true);
    assert.equal(store.revision, before.revision + 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rollback com falha de flush local reverte estado anterior', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-admin-rollback-flush-'));
  try {
    const store = new AdminConfigStore(path.join(dir, 'bot-config.json'));
    await store.load();
    const published = await store.publish('test');
    assert.equal(published.ok, true);
    const before = { revision: store.revision, active: clone(store.active), history: clone(store.history) };
    const originalFlush = store.flush.bind(store);
    store.flush = async () => { throw new Error('falha de gravação'); };
    const result = await store.rollback(1, 'test');
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /falha de gravação|persistência/i);
    assert.equal(store.revision, before.revision);
    assert.deepEqual(store.active, before.active);
    assert.equal(store.history.length, before.history.length);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('baseRevision desatualizada rejeita PATCH draft, publish e rollback sem alterar estado', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-admin-baserev-'));
  try {
    const store = new AdminConfigStore(path.join(dir, 'bot-config.json'));
    await store.load();
    const beforeDraft = clone(store.draft);
    const stale = Number(store.revision) + 3;

    const draftResult = await store.updateDraft({ business: { greeting: 'nova saudação' } }, 'test', stale);
    assert.equal(draftResult.ok, false);
    assert.match(draftResult.errors.join(' '), /config_alterada_por_outro_usuário/i);
    assert.deepEqual(store.draft, beforeDraft);

    const publishResult = await store.publish('test', stale);
    assert.equal(publishResult.ok, false);
    assert.match(publishResult.errors.join(' '), /config_alterada_por_outro_usuário/i);
    assert.equal(store.revision, Number(beforeDraft.revision ?? store.revision));

    // baseRevision correto funciona; sem baseRevision também (retrocompatível).
    const okDraft = await store.updateDraft({ business: { greeting: 'saudação ok' } }, 'test', store.revision);
    assert.equal(okDraft.ok, true);
    const okPublish = await store.publish('test');
    assert.equal(okPublish.ok, true);
    assert.ok(store.history.some(item => item.action === 'published' && item.snapshot));

    const rollbackStale = await store.rollback(1, 'test', stale + 10);
    assert.equal(rollbackStale.ok, false);
    assert.match(rollbackStale.errors.join(' '), /config_alterada_por_outro_usuário/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('SupabaseAdminConfigStore persiste updated_at no upsert de bot_config_state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-admin-updated-at-'));
  const writes = [];
  try {
    const store = new SupabaseAdminConfigStore(path.join(dir, 'bot-config.json'), {
      client: {
        enabled: true,
        async select(table) { return table === 'bot_config_state' ? [] : []; },
        async upsert(table, rows) { writes.push({ table, rows }); }
      },
      logger: { warn() {} }
    });
    await store.load();
    writes.length = 0;
    const result = await store.publish('test');
    assert.equal(result.ok, true);
    const stateRows = writes.filter(item => item.table === 'bot_config_state').flatMap(item => item.rows);
    assert.ok(stateRows.length >= 1);
    assert.ok(stateRows.every(row => typeof row.updated_at === 'string' && !Number.isNaN(Date.parse(row.updated_at))));
    assert.equal(store.updatedAt, stateRows.at(-1).updated_at);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('flush remoto do Supabase é serializado: upserts não correm fora de ordem', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-admin-remote-order-'));
  const order = [];
  const resolvers = [];
  let blocking = false;
  try {
    const store = new SupabaseAdminConfigStore(path.join(dir, 'bot-config.json'), {
      client: {
        enabled: true,
        async select(table) { return table === 'bot_config_state' ? [] : []; },
        async upsert(table, rows) {
          // Cada upsert remoto trava até ser liberado; grava a revisão ao final.
          const revision = rows[0]?.revision;
          if (blocking) await new Promise(resolve => resolvers.push(resolve));
          order.push(revision);
        }
      },
      logger: { warn() {} }
    });
    await store.load();
    order.length = 0; resolvers.length = 0; blocking = true;
    const first = store.flush(); // revisão atual
    store.revision += 1;
    store.updatedAt = new Date().toISOString();
    const second = store.flush(); // revisão seguinte
    assert.equal(resolvers.length, 2);
    resolvers[0]();
    await first;
    resolvers[1]();
    await second;
    assert.equal(order[0], store.revision - 1);
    assert.equal(order[1], store.revision);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
