import test from 'node:test';
import assert from 'node:assert/strict';
import { providerKey } from './whatsapp.mjs';

test('chave de idempotência permanece ByteString com resposta Unicode', () => {
  const key = providerKey('text', '5588921694598@s.whatsapp.net', {
    number: '5588921694598@s.whatsapp.net',
    text: 'Olá! Posso ajudar com 🐾 e informações sobre a Lia 💛',
  });

  assert.match(key, /^lia:text:[0-9a-f]{64}$/);
  assert.equal([...key].some(character => character.codePointAt(0) > 255), false);
});
