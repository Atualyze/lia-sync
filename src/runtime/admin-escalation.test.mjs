import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { LiaRuntimeStore, createLiaRuntime } from './index.mjs';

const silentLogger = { info() {}, warn() {}, error() {} };

test('Runtime: notifica o administrador em eventos que exigem decisão humana sem vazar payload', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-runtime-admin-escalation-'));
  let nowMs = Date.parse('2026-11-23T12:00:00Z');
  const notifications = [];

  try {
    const store = new LiaRuntimeStore({
      filePath: path.join(dir, 'lia-runtime.json'),
      logger: silentLogger,
      now: () => nowMs
    });
    const runtime = createLiaRuntime({
      store,
      notifyOwner: async message => notifications.push(message),
      logger: silentLogger,
      now: () => nowMs
    });
    await runtime.start();

    const { event } = await runtime.emitEvent({
      type: 'task.uncertain',
      source: 'copilot_worker',
      subject: 'contact-5511999990000',
      priority: 'critical',
      deduplicationKey: 'admin-review:task-uncertain-1',
      payload: { phone: '5511999990000', customerName: 'Cliente Exemplo', result: 'sensível' }
    });

    const first = await runtime.wake({ reason: 'admin_escalation_test' });
    assert.equal(first.needsHumanCount, 1);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /A Lia precisa de revisão humana/);
    assert.match(notifications[0], /task\.uncertain/);
    assert.match(notifications[0], new RegExp(event.id.slice(0, 8).toUpperCase()));
    assert.match(notifications[0], /não repetirá automaticamente/);
    assert.doesNotMatch(notifications[0], /5511999990000|Cliente Exemplo|sensível/);

    nowMs += 15_000;
    const second = await runtime.wake({ reason: 'admin_escalation_test' });
    assert.equal(second.processedEvents, 0);
    assert.equal(notifications.length, 1, 'evento processado não deve gerar alerta duplicado no ciclo seguinte');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
