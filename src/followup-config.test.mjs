import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { AdminConfigStore } from './admin-config.mjs';

test('configuração de follow-up aceita janela válida e rejeita máximo menor ou igual ao mínimo', async () => {
  const store = new AdminConfigStore(path.join(os.tmpdir(), `lia-config-${Date.now()}.json`));
  await store.load();
  const ok = await store.updateDraft({ behavior: { leadFollowUpEnabled: false, leadFollowUpMinHours: 18, leadFollowUpMaxHours: 48 } });
  assert.equal(ok.ok, true);
  const invalid = await store.updateDraft({ behavior: { leadFollowUpMinHours: 48, leadFollowUpMaxHours: 48 } });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' '), /janela do follow-up/i);
});
