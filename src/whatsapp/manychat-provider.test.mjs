import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  parseManyChatWebhookPayload,
  getManyChatSubscriberId,
  sendManyChatText,
  tagManyChatHandoff,
} from './manychat-provider.mjs';
import { handleWebhookRoutes } from '../http/webhook.mjs';

test('parseManyChatWebhookPayload converte texto e registra subscriber_id', () => {
  const payload = parseManyChatWebhookPayload({
    id: '987654',
    whatsapp_phone: '+55 (11) 99999-8888',
    name: 'Maria',
    last_input_text: 'Oi, quero um orçamento',
  });

  assert.equal(payload.event, 'MESSAGES_UPSERT');
  assert.equal(payload.instance, 'manychat');
  assert.equal(payload.data.pushName, 'Maria');
  assert.equal(payload.data.message.conversation, 'Oi, quero um orçamento');
  assert.match(payload.data.key.remoteJid, /5511999998888@s\.whatsapp\.net$/);
  assert.equal(getManyChatSubscriberId('5511999998888@s.whatsapp.net'), '987654');
});

test('parseManyChatWebhookPayload suporta áudio e imagem', () => {
  const audioPayload = parseManyChatWebhookPayload({
    id: '111',
    whatsapp_phone: '+5511911112222',
    last_input_audio_url: 'https://cdn.example.com/audio.ogg',
  });
  assert.equal(audioPayload.data.message.audioMessage.url, 'https://cdn.example.com/audio.ogg');

  const imagePayload = parseManyChatWebhookPayload({
    id: '222',
    whatsapp_phone: '+5511933334444',
    last_input_image_url: 'https://cdn.example.com/foto.jpg',
  });
  assert.equal(imagePayload.data.message.imageMessage.url, 'https://cdn.example.com/foto.jpg');
});

test('sendManyChatText e tagManyChatHandoff enviam chamadas corretas ao ManyChat', async () => {
  parseManyChatWebhookPayload({
    id: '555000',
    whatsapp_phone: '+5511955550000',
    last_input_text: 'teste',
  });

  const calls = [];
  const mockFetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    return new Response(JSON.stringify({ status: 'success' }), { status: 200 });
  };

  await sendManyChatText('5511955550000@s.whatsapp.net', 'Olá!', {
    token: 'mc-tok',
    replyFieldId: 42,
    sendflowNs: 'content_abc',
    fetchFn: mockFetch,
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/subscriber\/setCustomField$/);
  assert.deepEqual(calls[0].body, { subscriber_id: '555000', field_id: 42, field_value: 'Olá!' });
  assert.match(calls[1].url, /\/subscriber\/sendFlow$/);
  assert.deepEqual(calls[1].body, { subscriber_id: '555000', flow_ns: 'content_abc' });

  await tagManyChatHandoff('5511955550000', {
    token: 'mc-tok',
    transferTagName: 'transferido-humano',
    fetchFn: mockFetch,
  });

  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /\/subscriber\/addTagByName$/);
  assert.deepEqual(calls[2].body, { subscriber_id: '555000', tag_name: 'transferido-humano' });
});

test('handleWebhookRoutes /webhook/manychat falha fechado com 401 sem token', async () => {
  const req = Readable.from([JSON.stringify({ id: '1', whatsapp_phone: '+5511900000000', last_input_text: 'oi' })]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };

  let statusCode = 0;
  let bodyOut = '';
  const res = {
    writeHead(code) { statusCode = code; },
    end(chunk) { bodyOut = String(chunk || ''); },
  };

  await handleWebhookRoutes({
    req,
    res,
    u: new URL('http://localhost/webhook/manychat'),
    webhookAuthorize: async () => false,
  });

  assert.equal(statusCode, 401);
  assert.match(bodyOut, /unauthorized/);
});
