import test from 'node:test';
import assert from 'node:assert/strict';
import { stableIdlessEventKey, handleWebhookRoutes } from './webhook.mjs';
import { NOT_HANDLED } from './utils.mjs';
import { parsePayload } from '../whatsapp.mjs';

test('stableIdlessEventKey gera chave deterministica para eventos sem id', () => {
  const item = { jid: '5511999998888@s.whatsapp.net', eventTimestamp: 1700000000, text: 'oi' };
  const k1 = stableIdlessEventKey(item, 'messages.upsert');
  const k2 = stableIdlessEventKey(item, 'messages.upsert');
  assert.equal(k1, k2);
  assert.ok(k1.startsWith('fingerprint:'));
});

test('handleWebhookRoutes retorna NOT_HANDLED para rotas nao-webhook', async () => {
  const res = { writeHead() {}, end() {} };
  const result = await handleWebhookRoutes({
    req: { method: 'GET', url: '/health', headers: {} },
    res,
    u: new URL('http://localhost/health')
  });
  assert.equal(result, NOT_HANDLED);
});

test('handleWebhookRoutes retorna 401 quando webhookAuthorize rejeita', async () => {
  let statusCode = 0;
  let body = '';
  const res = {
    writeHead(code) { statusCode = code; },
    end(chunk) { body = String(chunk || ''); }
  };
  await handleWebhookRoutes({
    req: { method: 'POST', url: '/webhook/evolution', headers: {} },
    res,
    u: new URL('http://localhost/webhook/evolution'),
    webhookAuthorize: () => false
  });
  assert.equal(statusCode, 401);
  assert.ok(body.includes('unauthorized') || body.length > 0);
});

test('handleWebhookRoutes retorna 401 quando webhookAuthorize retorna { ok: false }', async () => {
  let statusCode = 0;
  let body = '';
  const res = {
    writeHead(code) { statusCode = code; },
    end(chunk) { body = String(chunk || ''); }
  };
  await handleWebhookRoutes({
    req: { method: 'POST', url: '/webhook/evolution', headers: {} },
    res,
    u: new URL('http://localhost/webhook/evolution'),
    webhookAuthorize: () => ({ ok: false })
  });
  assert.equal(statusCode, 401);
  assert.ok(body.includes('unauthorized'));
});

test('comando bot no self-chat segue para o Copiloto em vez do atalho de cliente', async () => {
  const scheduled = [];
  const res = { writeHead() {}, end() {} };
  const payload = {
    event: 'MESSAGES_UPSERT',
    data: {
      key: { id: `cmd-self-${Date.now()}`, remoteJid: '5588992023309@s.whatsapp.net', fromMe: true },
      message: { conversation: 'bot +55 88 99360-2644' }
    }
  };
  const req = {
    method: 'POST',
    url: '/webhook/evolution',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); }
  };
  const store = {
    rememberLid() {},
    get() { throw new Error('self-chat não deve usar a sessão numérica do atalho'); }
  };
  const f = { isDuplicate: () => false, allowRate: () => true };
  const webhookEventStore = {
    async begin() { return { tracked: true, duplicate: false, key: 'k' }; },
    async finish() {}
  };

  await handleWebhookRoutes({
    req,
    res,
    u: new URL('http://localhost/webhook/evolution'),
    webhookAuthorize: () => true,
    store,
    f,
    adminConfig: { active: { human: { phone: '5588992023309' } } },
    getHumanPhone: () => '5588992023309',
    getCachedInstanceOwner: () => null,
    updateInstanceOwner: async () => {},
    rateMessage: '',
    webhookEventStore,
    schedule: async job => scheduled.push(job)
  });

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].phone, 'owner_self');
  assert.equal(scheduled[0].text, 'bot +55 88 99360-2644');
});


test('parsePayload transforma resposta de botão do WhatsApp em mensagem processável e preserva o reply', () => {
  const item = parsePayload({
    event: 'MESSAGES_UPSERT',
    instance: 'baileys',
    data: {
      key: { id: 'reply-button-1', remoteJid: '5511999999999@s.whatsapp.net' },
      message: {
        buttonsResponseMessage: {
          selectedDisplayText: 'Sim, pode confirmar',
          selectedButtonId: 'confirm_booking',
          contextInfo: {
            quotedMessage: { conversation: 'Você confirma o agendamento para amanhã?' }
          }
        }
      }
    }
  });

  assert.equal(item.text, 'Sim, pode confirmar');
  assert.equal(item.nonText, false);
  assert.match(item.contextText, /respondendo\/citando/i);
  assert.match(item.contextText, /Você confirma o agendamento para amanhã\?/);
  assert.match(item.contextText, /confirm_booking/);
});

test('parsePayload reconhece mensagens encaminhadas no WhatsApp sem misturar os metadados ao texto do usuário', () => {
  const item = parsePayload({
    event: 'MESSAGES_UPSERT',
    data: {
      key: { id: 'forward-1', remoteJid: '5511999999999@s.whatsapp.net' },
      message: {
        extendedTextMessage: {
          text: 'Pode verificar essa informação?',
          contextInfo: { isForwarded: true, forwardingScore: 1 }
        }
      }
    }
  });

  assert.equal(item.text, 'Pode verificar essa informação?');
  assert.match(item.contextText, /encaminhada pelo contato/i);
  assert.doesNotMatch(item.text, /encaminhada pelo contato/i);
});
