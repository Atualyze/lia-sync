import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTelegramCopilot,
  parseAdminChatIds,
  formatTelegramHtml,
  splitTelegramMessage,
  mapTelegramSlashCommand
} from './channels/telegram.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';
import { redactSecrets } from './ops/log-redaction.mjs';

test('parseAdminChatIds aceita múltiplos IDs positivos e negativos', () => {
  assert.deepEqual(parseAdminChatIds('123456, -987654 ; abc 555'), ['123456', '-987654', '555']);
  assert.deepEqual(parseAdminChatIds(''), []);
});

test('formatTelegramHtml escapa HTML e converte negrito e código', () => {
  const html = formatTelegramHtml('Olá *Tauan*! Use `/status` <script>alert(1)</script>');
  assert.equal(html, 'Olá <b>Tauan</b>! Use <code>/status</code> &lt;script&gt;alert(1)&lt;/script&gt;');
});

test('splitTelegramMessage divide mensagens longas preservando conteúdo', () => {
  const longText = Array.from({ length: 120 }, (_, i) => `Linha ${i + 1}: conteúdo de teste`).join('\n');
  const chunks = splitTelegramMessage(longText, 400);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every(c => c.length <= 400));
  assert.ok(chunks.join('\n').includes('Linha 120'));
});

test('mapTelegramSlashCommand traduz comandos nativos do Telegram para intenções do Copiloto', () => {
  assert.deepEqual(mapTelegramSlashCommand('/meu_id'), { kind: 'meu_id' });
  assert.deepEqual(mapTelegramSlashCommand('/status@liasync_bot'), { kind: 'text', text: 'status' });
  assert.deepEqual(mapTelegramSlashCommand('/saude'), { kind: 'text', text: 'verificar saude da infraestrutura' });
  assert.deepEqual(mapTelegramSlashCommand('/fila'), { kind: 'text', text: 'fila' });
  assert.deepEqual(mapTelegramSlashCommand('/rotinas'), { kind: 'text', text: 'listar minhas rotinas' });
  assert.deepEqual(mapTelegramSlashCommand('/agenda amanhã'), { kind: 'text', text: 'consultar agenda google: amanhã' });
  assert.deepEqual(mapTelegramSlashCommand('/gmail fatura'), { kind: 'text', text: 'buscar emails no gmail: fatura' });
});

test('redactSecrets oculta tokens de bot do Telegram', () => {
  const redacted = redactSecrets('Erro em https://api.telegram.org/bot123456789:AAHfakeSecretToken_1234567890/getMe');
  assert.ok(!redacted.includes('AAHfakeSecretToken'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('Telegram Copiloto permite /meu_id sem admin configurado e bloqueia estranhos quando configurado', async () => {
  const apiCalls = [];
  const cfg = { telegramBotToken: '123456:AAHtestToken_123456789012345', telegramAdminChatId: '' };
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    apiCalls.push({ method, body });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  let flowCalls = 0;
  const bot = createTelegramCopilot({
    getConfig: () => cfg,
    flow: { process: async () => { flowCalls += 1; return 'ok'; } },
    fetchImpl,
    logger: { log() {}, warn() {}, error() {} }
  });

  // Sem admin configurado: /meu_id devolve o Chat ID
  await bot.handleUpdate({ message: { message_id: 10, chat: { id: 999888 }, text: '/meu_id' } });
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].method, 'sendMessage');
  assert.ok(apiCalls[0].body.text.includes('999888'));
  assert.equal(flowCalls, 0);

  // Com admin configurado: outro chat_id é ignorado
  cfg.telegramAdminChatId = '999888';
  apiCalls.length = 0;
  await bot.handleUpdate({ message: { message_id: 11, chat: { id: 111222 }, text: '/status' } });
  assert.equal(apiCalls.length, 0);
  assert.equal(flowCalls, 0);
});

test('Telegram Copiloto roteia comandos, áudio e botões inline de aprovação para OWNER_SELF_KEY', async () => {
  const apiCalls = [];
  const processed = [];
  const cfg = { telegramBotToken: '123456:AAHtestToken_123456789012345', telegramAdminChatId: '999888' };
  const ownerSession = { pendingOutboundDispatch: null };
  const store = {
    get: (key) => (key === OWNER_SELF_KEY ? ownerSession : null),
    enqueue: async (_key, fn) => fn(),
    flush: async () => {}
  };
  const fetchImpl = async (url, init) => {
    if (url.includes('/file/bot')) {
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('ogg-bytes') };
    }
    const method = url.split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    apiCalls.push({ method, body });
    if (method === 'getFile') {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: 9 } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 42 } }) };
  };
  const bot = createTelegramCopilot({
    getConfig: () => cfg,
    store,
    transcribeAudio: async () => 'avisar o cliente João que a reunião foi confirmada',
    flow: {
      process: async (payload) => {
        processed.push(payload);
        if (payload.text.includes('avisar o cliente')) {
          ownerSession.pendingOutboundDispatch = { target: '558899999999' };
          return 'Prévia pronta! Deseja aprovar o disparo?';
        }
        if (payload.text === 'sim, aprovar disparo') {
          ownerSession.pendingOutboundDispatch = null;
          return '✅ Disparo enviado com sucesso!';
        }
        return 'Tudo certo por aqui.';
      }
    },
    fetchImpl,
    logger: { log() {}, warn() {}, error() {} }
  });

  // 1. Nota de voz -> transcreve -> gera prévia com botões inline
  await bot.handleUpdate({
    message: {
      message_id: 20,
      chat: { id: 999888 },
      from: { first_name: 'Tauan' },
      voice: { file_id: 'voice_123', mime_type: 'audio/ogg' }
    }
  });
  assert.equal(processed.length, 1);
  assert.equal(processed[0].phone, OWNER_SELF_KEY);
  assert.equal(processed[0].origin, 'telegram');
  assert.ok(processed[0].text.includes('avisar o cliente João'));
  const sendWithButtons = apiCalls.find(c => c.method === 'sendMessage');
  assert.ok(sendWithButtons);
  assert.equal(sendWithButtons.body.reply_markup.inline_keyboard[0][0].callback_data, 'outbound:approve');

  // 2. Clique no botão Aprovar -> remove teclado e executa aprovação no Copiloto
  apiCalls.length = 0;
  await bot.handleUpdate({
    callback_query: {
      id: 'cb_1',
      data: 'outbound:approve',
      from: { first_name: 'Tauan' },
      message: { message_id: 42, chat: { id: 999888 } }
    }
  });
  assert.equal(processed.length, 2);
  assert.equal(processed[1].text, 'sim, aprovar disparo');
  assert.ok(apiCalls.some(c => c.method === 'answerCallbackQuery'));
  assert.ok(apiCalls.some(c => c.method === 'editMessageReplyMarkup'));
  assert.ok(apiCalls.some(c => c.method === 'sendMessage' && c.body.text.includes('Disparo enviado')));
});

test('notifyAdmin espelha alertas e faz fallback para texto puro se HTML retornar 400', async () => {
  const apiCalls = [];
  const cfg = { telegramBotToken: '123456:AAHtestToken_123456789012345', telegramAdminChatId: '999888' };
  let firstCall = true;
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    apiCalls.push({ method, body });
    if (method === 'sendMessage' && firstCall) {
      firstCall = false;
      return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: can\'t parse entities' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
  };
  const bot = createTelegramCopilot({
    getConfig: () => cfg,
    fetchImpl,
    logger: { log() {}, warn() {}, error() {} }
  });

  const res = await bot.notifyAdmin('🔔 *Alerta:* cliente aguardando');
  assert.equal(res.sent, 1);
  assert.equal(apiCalls.length, 2);
  assert.equal(apiCalls[0].body.parse_mode, 'HTML');
  assert.equal(apiCalls[1].body.parse_mode, undefined);
});
