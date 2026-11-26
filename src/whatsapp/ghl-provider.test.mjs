import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  parseGhlWebhookPayload,
  getGhlContact,
  sendGhlText,
  tagGhlHandoff,
  updateGhlOpportunityStage,
} from './ghl-provider.mjs';
import { handleWebhookRoutes } from '../http/webhook.mjs';

test('parseGhlWebhookPayload converte texto e registra contactId', () => {
  const payload = parseGhlWebhookPayload({
    contact_id: 'ghl_c_123',
    location_id: 'loc_999',
    phone: '+55 (11) 98888-7777',
    full_name: 'Carlos Silva',
    message: { body: 'Quero agendar uma consulta' },
  });

  assert.equal(payload.event, 'MESSAGES_UPSERT');
  assert.equal(payload.instance, 'ghl');
  assert.equal(payload.data.pushName, 'Carlos Silva');
  assert.equal(payload.data.message.conversation, 'Quero agendar uma consulta');
  assert.match(payload.data.key.remoteJid, /5511988887777@s\.whatsapp\.net$/);
  assert.deepEqual(getGhlContact('5511988887777@s.whatsapp.net'), {
    contactId: 'ghl_c_123',
    locationId: 'loc_999',
  });
});

test('parseGhlWebhookPayload suporta áudio e imagem em attachments', () => {
  const audioPayload = parseGhlWebhookPayload({
    contactId: 'ghl_a_1',
    phone: '+5511911112222',
    attachments: [{ type: 'audio/ogg', url: 'https://cdn.ghl.test/voz.ogg' }],
  });
  assert.equal(audioPayload.data.message.audioMessage.url, 'https://cdn.ghl.test/voz.ogg');

  const imagePayload = parseGhlWebhookPayload({
    contactId: 'ghl_i_2',
    phone: '+5511933334444',
    attachments: [{ type: 'image/jpeg', url: 'https://cdn.ghl.test/foto.jpg' }],
  });
  assert.equal(imagePayload.data.message.imageMessage.url, 'https://cdn.ghl.test/foto.jpg');
});

test('sendGhlText, tagGhlHandoff e updateGhlOpportunityStage chamam API v2 corretamente', async () => {
  parseGhlWebhookPayload({
    contact_id: 'ghl_c_555',
    phone: '+5511955551111',
    message: 'oi',
  });

  const calls = [];
  const mockFetch = async (url, opts) => {
    calls.push({
      url,
      method: opts.method,
      version: opts.headers.Version,
      body: JSON.parse(opts.body),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  await sendGhlText('5511955551111@s.whatsapp.net', 'Olá do GHL!', {
    token: 'ghl-tok',
    fetchFn: mockFetch,
  });

  await tagGhlHandoff('5511955551111', {
    token: 'ghl-tok',
    transferTag: 'transferido-humano',
    fetchFn: mockFetch,
  });

  await updateGhlOpportunityStage('opp_77', 'stage_agendado', {
    token: 'ghl-tok',
    pipelineId: 'pipe_1',
    fetchFn: mockFetch,
  });

  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/conversations\/messages$/);
  assert.equal(calls[0].version, '2021-04-15');
  assert.deepEqual(calls[0].body, {
    type: 'WhatsApp',
    contactId: 'ghl_c_555',
    message: 'Olá do GHL!',
  });

  assert.match(calls[1].url, /\/contacts\/ghl_c_555\/tags$/);
  assert.deepEqual(calls[1].body, { tags: ['transferido-humano'] });

  assert.match(calls[2].url, /\/opportunities\/opp_77$/);
  assert.equal(calls[2].method, 'PUT');
  assert.deepEqual(calls[2].body, {
    pipelineStageId: 'stage_agendado',
    pipelineId: 'pipe_1',
  });
});

test('handleWebhookRoutes /webhook/ghl falha fechado com 401 sem token', async () => {
  const req = Readable.from([JSON.stringify({ contact_id: '1', phone: '+5511900000000', message: 'oi' })]);
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
    u: new URL('http://localhost/webhook/ghl'),
    webhookAuthorize: async () => false,
  });

  assert.equal(statusCode, 401);
  assert.match(bodyOut, /unauthorized/);
});
