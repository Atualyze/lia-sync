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
