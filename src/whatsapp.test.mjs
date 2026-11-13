import test from 'node:test';
import assert from 'node:assert/strict';
import { sendText, setOutboundSuppressionCheck } from './whatsapp.mjs';

test('envio falha fechado sem verificador de supressão', async () => {
  setOutboundSuppressionCheck(null);
  await assert.rejects(sendText('5511999999999', 'mensagem de teste'), { code: 'suppression_check_unavailable' });
});
