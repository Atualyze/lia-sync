import test from 'node:test';
import assert from 'node:assert/strict';
import { stableIdlessEventKey } from './http/webhook.mjs';

test('fingerprint idless é estável para retry e distingue conteúdo de mídia diferente', () => {
  const base = { eventTimestamp: 1794500000000, instance: 'lia', jid: '5511999999999@s.whatsapp.net', phone: '5511999999999', mediaType: 'audio', text: '', fromMe: false, message: { audioMessage: { mediaKey: 'a' } } };
  assert.equal(stableIdlessEventKey(base, 'MESSAGESUPSERT'), stableIdlessEventKey(structuredClone(base), 'MESSAGESUPSERT'));
  assert.notEqual(stableIdlessEventKey(base, 'MESSAGESUPSERT'), stableIdlessEventKey({ ...base, message: { audioMessage: { mediaKey: 'b' } } }, 'MESSAGESUPSERT'));
  assert.equal(stableIdlessEventKey({ ...base, eventTimestamp: null }, 'MESSAGESUPSERT'), null);
});
