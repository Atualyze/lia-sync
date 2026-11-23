import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { createAutonomyEngine } from './engine.mjs';
import { LiaAutonomyStore } from './store.mjs';

const silentLogger = { info() {}, warn() {}, error() {} };

test('reserva proativa local persiste antes do envio e mantém o status final após reload', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-autonomy-notify-'));
  const filePath = path.join(dir, 'autonomy.json');
  try {
    const store = new LiaAutonomyStore({ filePath, logger: silentLogger });
    await store.load();
    const params = {
      tenantId: 'default',
      deduplicationKey: 'daily_review:default:2026-11-23',
      subject: 'owner:default',
      reason: 'daily_review'
    };

    assert.equal(await store.claimProactiveNotification(params), true);
    assert.equal(await store.claimProactiveNotification(params), false);
    assert.equal(await store.finalizeProactiveNotification({ deduplicationKey: params.deduplicationKey, status: 'sent' }), true);

    const restartedStore = new LiaAutonomyStore({ filePath, logger: silentLogger });
    await restartedStore.load();
    assert.equal(await restartedStore.claimProactiveNotification(params), false);
    const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(snapshot.notifications[0].status, 'sent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reserva remota usa conflito único como eleição atômica entre réplicas', async () => {
  const claimedKeys = new Set();
  const client = {
    enabled: true,
    async select() { return []; },
    async request(table, options) {
      assert.equal(table, 'lia_proactive_notifications');
      assert.equal(options.method, 'POST');
      assert.equal(options.query, 'on_conflict=deduplication_key');
      assert.equal(options.prefer, 'resolution=ignore-duplicates,return=representation');
      const row = options.body[0];
      if (claimedKeys.has(row.deduplication_key)) return [];
      claimedKeys.add(row.deduplication_key);
      return [row];
    },
    async patch() { return null; }
  };
  const firstReplica = new LiaAutonomyStore({ client, logger: silentLogger });
  const secondReplica = new LiaAutonomyStore({ client, logger: silentLogger });
  await Promise.all([firstReplica.load(), secondReplica.load()]);
  const params = { deduplicationKey: 'daily_review:default:2026-11-23' };

  const claims = await Promise.all([
    firstReplica.claimProactiveNotification(params),
    secondReplica.claimProactiveNotification(params)
  ]);
  assert.deepEqual(claims.sort(), [false, true]);
});

test('revisão diária usa a data do fuso configurado e não reenvia após restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-autonomy-daily-'));
  const filePath = path.join(dir, 'autonomy.json');
  const now = () => Date.parse('2026-11-23T02:00:00.000Z');
  let runtimeReads = 0;
  const runtime = {
    available: true,
    goals: {
      async list() {
        runtimeReads += 1;
        return [{ id: 'goal-1', title: 'Verificar operação', priority: 'high', status: 'active', updated_at: new Date(now()).toISOString() }];
      }
    },
    commitments: { async list() { runtimeReads += 1; return []; } }
  };
  const sent = [];
  const makeEngine = store => createAutonomyEngine({
    store,
    runtime,
    notifyProactive: async notification => sent.push(notification),
    logger: silentLogger,
    now
  });

  try {
    const firstStore = new LiaAutonomyStore({ filePath, logger: silentLogger, now });
    const firstEngine = makeEngine(firstStore);
    await firstEngine.start();
    const firstReview = await firstEngine.runDailyReview({ timeZone: 'America/Sao_Paulo' });

    const restartedStore = new LiaAutonomyStore({ filePath, logger: silentLogger, now });
    const restartedEngine = makeEngine(restartedStore);
    await restartedEngine.start();
    const repeatedReview = await restartedEngine.runDailyReview({ timeZone: 'America/Sao_Paulo' });

    assert.equal(firstReview.notified, true);
    assert.equal(repeatedReview.notified, false);
    assert.equal(repeatedReview.alreadyReviewed, true);
    assert.equal(sent.length, 1);
    assert.equal(runtimeReads, 2);
    assert.equal(sent[0].subject, 'owner:default');
    const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(snapshot.notifications[0].deduplication_key, 'daily_review:default:2026-11-22');
    assert.equal(snapshot.notifications[0].status, 'sent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('revisão diária sem pendências persiste supressão e não acorda de novo no mesmo dia', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-autonomy-empty-review-'));
  const filePath = path.join(dir, 'autonomy.json');
  const now = () => Date.parse('2026-11-23T15:00:00.000Z');
  let runtimeReads = 0;
  const runtime = {
    available: true,
    goals: { async list() { runtimeReads += 1; return []; } },
    commitments: { async list() { runtimeReads += 1; return []; } }
  };
  try {
    const firstStore = new LiaAutonomyStore({ filePath, logger: silentLogger, now });
    const firstEngine = createAutonomyEngine({ store: firstStore, runtime, now, logger: silentLogger });
    await firstEngine.start();
    const review = await firstEngine.runDailyReview({ timeZone: 'America/Sao_Paulo' });

    const restartedStore = new LiaAutonomyStore({ filePath, logger: silentLogger, now });
    const restartedEngine = createAutonomyEngine({ store: restartedStore, runtime, now, logger: silentLogger });
    await restartedEngine.start();
    const repeated = await restartedEngine.runDailyReview({ timeZone: 'America/Sao_Paulo' });

    assert.equal(review.notified, false);
    assert.equal(repeated.alreadyReviewed, true);
    assert.equal(runtimeReads, 2);
    const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(snapshot.notifications[0].status, 'suppressed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
