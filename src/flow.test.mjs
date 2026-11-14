import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createFlow } from './flow.mjs';
import { SessionStore } from './sessions.mjs';

test('createFlow deduplica ids de mensagens dentro da janela', () => {
  const store = new SessionStore(path.join(os.tmpdir(), `flow-${Date.now()}.json`));
  const flow = createFlow({
    store,
    send: async () => {},
    ai: async () => ({ reply: 'oi' })
  });
  assert.equal(flow.isDuplicate('msg-1'), false);
  assert.equal(flow.isDuplicate('msg-1'), true);
});
