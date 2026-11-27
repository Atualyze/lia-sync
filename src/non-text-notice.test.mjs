import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createFlow } from './flow.mjs';
import { SessionStore } from './sessions.mjs';

test('documento sem texto recebe aviso uma vez e não derruba o fluxo (nonTextNotice definido)', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `lia-non-text-${Date.now()}.json`));
  await store.load();
  const phone = '5511999990077';
  const flow = createFlow({
    store,
    getBotConfig: () => ({ identity: { botName: 'Lia', responsible: 'Equipe' } }),
    faq: async () => [],
    whatsapp: { async getMediaBase64() { return null; } },
    ai: {
      async analyzeDocument() { return null; },
      async askAI() { return { reply: 'não deveria chamar a IA' }; }
    }
  });
  const send = id => flow.process({ phone, text: '', mediaType: 'document', nonText: true, rawItem: { jid: phone, message: {} }, messageId: id });

  const first = await send('doc-1');
  assert.match(String(first), /Recebi seu arquivo/);
  const second = await send('doc-2');
  assert.equal(second, null);
});
