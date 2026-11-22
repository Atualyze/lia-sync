import { config } from '../config.mjs';
import { OWNER_SELF_KEY } from '../core/identity.mjs';
import { formatOutgoingMessage } from '../core/format.mjs';
import { redactSecrets } from '../ops/log-redaction.mjs';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_LEN = 3900;
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const POLL_TIMEOUT_SECONDS = 25;

export const TELEGRAM_COMMANDS = Object.freeze([
  { command: 'status', description: 'Status geral, WhatsApp e IA' },
  { command: 'saude', description: 'Diagnóstico completo da infraestrutura' },
  { command: 'fila', description: 'Clientes aguardando atendimento humano' },
  { command: 'rotinas', description: 'Listar rotinas e agendamentos autônomos' },
  { command: 'agenda', description: 'Próximos compromissos no Google Calendar' },
  { command: 'gmail', description: 'Buscar últimos e-mails no Gmail' },
  { command: 'planilha', description: 'Ver últimos leads no Google Sheets' },
  { command: 'meu_id', description: 'Mostrar seu Chat ID para vincular no painel' },
  { command: 'ajuda', description: 'Ver comandos e funções da Lia no Telegram' }
]);

const APPROVAL_KEYBOARD = Object.freeze({
  inline_keyboard: [[
    { text: '✅ Aprovar disparo', callback_data: 'outbound:approve' },
    { text: '❌ Cancelar', callback_data: 'outbound:cancel' }
  ]]
});

export function parseAdminChatIds(raw = '') {
  return String(raw || '')
    .split(/[,\s;]+/)
    .map(s => s.trim())
    .filter(s => /^-?\d+$/.test(s));
}

export function escapeTelegramHtml(text = '') {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatTelegramHtml(text = '') {
  const escaped = escapeTelegramHtml(text);
  // Converte blocos ```code``` -> <pre>code</pre>, `code` -> <code>code</code>, *bold* -> <b>bold</b>
  return escaped
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/(^|[\s(>])\*([^*\n]+)\*(?=[\s.,!?:;)<]|$)/gm, '$1<b>$2</b>');
}

export function splitTelegramMessage(text = '', maxLen = MAX_MESSAGE_LEN) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (raw.length <= maxLen) return [raw];
  const chunks = [];
  let remaining = raw;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen * 0.4) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.4) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

export function mapTelegramSlashCommand(rawText = '') {
  const trimmed = String(rawText || '').trim();
  if (!trimmed.startsWith('/')) return { kind: 'text', text: trimmed };
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return { kind: 'text', text: trimmed };
  const cmd = match[1].toLowerCase();
  const args = String(match[2] || '').trim();

  if (cmd === 'meu_id' || cmd === 'id') return { kind: 'meu_id' };
  if (cmd === 'start') return { kind: 'start' };
  if (cmd === 'ajuda' || cmd === 'help') return { kind: 'help' };
  if (cmd === 'status') return { kind: 'text', text: 'status' };
  if (cmd === 'saude' || cmd === 'infra') return { kind: 'text', text: 'verificar saude da infraestrutura' };
  if (cmd === 'fila') return { kind: 'text', text: 'fila' };
  if (cmd === 'rotinas' || cmd === 'agendamentos') return { kind: 'text', text: 'listar minhas rotinas' };
  if (cmd === 'agenda') {
    return {
      kind: 'text',
      text: args ? `consultar agenda google: ${args}` : 'quais os proximos eventos na agenda google?'
    };
  }
  if (cmd === 'gmail' || cmd === 'emails' || cmd === 'email') {
    return {
      kind: 'text',
      text: args ? `buscar emails no gmail: ${args}` : 'buscar os ultimos 5 emails recentes no gmail'
    };
  }
  if (cmd === 'planilha' || cmd === 'leads') {
    return {
      kind: 'text',
      text: args ? `consultar planilha google: ${args}` : 'ler as ultimas linhas da planilha de leads no google sheets'
    };
  }
  return { kind: 'text', text: trimmed };
}

function buildHelpText(botUsername = '') {
  const handle = botUsername ? ` (@${botUsername})` : '';
  return [
    `🤖 *Lia Copiloto no Telegram${handle}*`,
    '',
    'Este canal compartilha a mesma memória, histórico e ferramentas do seu chat interno no WhatsApp.',
    '',
    '*Comandos rápidos:*',
    '• /status — Status geral, WhatsApp e IA',
    '• /saude — Diagnóstico completo da infraestrutura',
    '• /fila — Clientes aguardando atendimento humano',
    '• /rotinas — Listar rotinas e agendamentos autônomos',
    '• /agenda — Próximos compromissos no Google Calendar',
    '• /gmail — Últimos e-mails no Gmail (ou `/gmail assunto`)',
    '• /planilha — Últimos leads no Google Sheets',
    '• /meu_id — Mostrar seu Chat ID',
    '',
    '*Dica:* Você também pode mandar mensagens livres ou *áudios de voz* — eu transcrevo e executo normalmente (ex.: *"todo dia às 9h verificar saúde da infra"*, *"agendar reunião amanhã 15h"*, *"assumir cliente 1"*).'
  ].join('\n');
}

export function createTelegramCopilot({
  getConfig = () => config,
  flow = null,
  store = null,
  transcribeAudio = null,
  broadcastBridgeEvent = null,
  fetchImpl = globalThis.fetch,
  logger = console
} = {}) {
  let running = false;
  let polling = false;
  let activeToken = '';
  let botUsername = '';
  let botId = null;
  let offset = 0;
  let status = 'not_configured';
  let lastError = null;
  let lastUpdateAt = null;
  let pollAbortController = null;
  let retryTimer = null;
  let backoffMs = 2000;
  const unauthorizedLogged = new Set();

  const currentToken = () => String(getConfig()?.telegramBotToken || '').trim();
  const currentAdminIds = () => parseAdminChatIds(getConfig()?.telegramAdminChatId || '');

  const safeLogError = (prefix, err) => {
    const msg = redactSecrets(err?.message || String(err || 'unknown_error'));
    logger.error?.(`${prefix} ${msg}`);
  };

  async function apiCall(method, payload = {}, { token = currentToken(), signal = undefined, timeoutMs = 20000 } = {}) {
    if (!token) throw new Error('telegram_token_missing');
    const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        const desc = redactSecrets(data?.description || `HTTP ${res.status}`);
        throw Object.assign(new Error(`telegram_${method}_failed: ${desc}`), {
          status: res.status,
          telegramErrorCode: data?.error_code || res.status
        });
      }
      return data.result;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }

  async function sendMessage(chatId, text, { replyMarkup = undefined, token = currentToken() } = {}) {
    const formatted = formatOutgoingMessage(String(text || '').trim());
    const chunks = splitTelegramMessage(formatted);
    if (!chunks.length) return false;
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      const chunk = chunks[i];
      const basePayload = {
        chat_id: chatId,
        disable_web_page_preview: true,
        ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {})
      };
      try {
        await apiCall('sendMessage', {
          ...basePayload,
          text: formatTelegramHtml(chunk),
          parse_mode: 'HTML'
        }, { token });
      } catch (err) {
        // Fallback seguro para texto puro caso o Telegram rejeite alguma tag HTML
        if (err?.telegramErrorCode === 400 || err?.status === 400) {
          await apiCall('sendMessage', {
            ...basePayload,
            text: chunk
          }, { token });
        } else {
          throw err;
        }
      }
    }
    return true;
  }

  async function downloadTelegramAudio(fileId, mimeType = 'audio/ogg') {
    const token = currentToken();
    if (!token || !fileId) return null;
    const fileInfo = await apiCall('getFile', { file_id: fileId }, { token, timeoutMs: 15000 });
    const filePath = String(fileInfo?.file_path || '').trim();
    if (!filePath || filePath.includes('..')) return null;
    if (Number(fileInfo?.file_size || 0) > MAX_MEDIA_BYTES) {
      throw new Error('telegram_audio_too_large');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetchImpl(`${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`telegram_file_download_http_${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_MEDIA_BYTES) throw new Error('telegram_audio_too_large');
      return { base64: buf.toString('base64'), mimeType };
    } finally {
      clearTimeout(timer);
    }
  }

  async function runOwnerTurn({ chatId, text, pushName = '', messageId = '' }) {
    if (!flow?.process) return;
    void apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    const exec = async () => {
      const reply = await flow.process({
        phone: OWNER_SELF_KEY,
        text,
        origin: 'telegram',
        nonText: false,
        mediaType: 'text',
        rawItem: { channel: 'telegram', chatId: String(chatId) },
        pushName: pushName || 'Admin Telegram',
        authorizedResume: true,
        messageId: messageId ? `tg:${messageId}` : ''
      });
      await store?.flush?.().catch(() => {});
      return reply;
    };

    const reply = typeof store?.enqueue === 'function'
      ? await store.enqueue(OWNER_SELF_KEY, exec)
      : await exec();

    if (!reply) return;

    const ownerSession = store?.get?.(OWNER_SELF_KEY);
    const hasPendingApproval = Boolean(ownerSession?.pendingOutboundDispatch);
    await sendMessage(chatId, reply, {
      replyMarkup: hasPendingApproval ? APPROVAL_KEYBOARD : undefined
    });
    broadcastBridgeEvent?.('bot_reply', {
      phone: OWNER_SELF_KEY,
      text: reply,
      source: 'telegram',
      timestamp: Date.now()
    });
  }

  async function handleMessage(msg) {
    const chatId = msg?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    const chatIdStr = String(chatId);
    const adminIds = currentAdminIds();
    const isAuthorized = adminIds.includes(chatIdStr);
    const rawText = String(msg.text || msg.caption || '').trim();
    const parsedCmd = mapTelegramSlashCommand(rawText);

    // Permite /meu_id ou /start para descoberta do Chat ID apenas quando ainda não há admin vinculado (ou se já for admin)
    if (parsedCmd.kind === 'meu_id' || (parsedCmd.kind === 'start' && adminIds.length === 0)) {
      if (!isAuthorized && adminIds.length > 0) return;
      const setupNote = adminIds.length === 0
        ? '\n\nCole esse número no painel da Lia Sync em *Integrações → Telegram Admin Chat ID* e clique em Salvar para ativar o Copiloto.'
        : '\n\n✅ Este Chat ID já está autorizado como administrador da Lia Sync.';
      await sendMessage(chatId, `🆔 *Seu Telegram Chat ID:* \`${chatIdStr}\`${setupNote}`);
      return;
    }

    if (!isAuthorized) {
      if (!unauthorizedLogged.has(chatIdStr)) {
        unauthorizedLogged.add(chatIdStr);
        if (unauthorizedLogged.size > 100) unauthorizedLogged.clear();
        logger.warn?.(`[telegram] Mensagem ignorada de chat não autorizado (${chatIdStr}).`);
      }
      return;
    }

    if (parsedCmd.kind === 'start' || parsedCmd.kind === 'help') {
      await sendMessage(chatId, buildHelpText(botUsername));
      return;
    }

    const pushName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').trim() || msg.from?.username || '';
    const messageId = String(msg.message_id || '');

    // Áudio / Nota de voz
    const audioObj = msg.voice || msg.audio;
    if (audioObj?.file_id) {
      if (typeof transcribeAudio !== 'function') {
        await sendMessage(chatId, '⚠️ Recebi seu áudio, mas a transcrição de voz não está disponível no momento.');
        return;
      }
      void apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      try {
        const media = await downloadTelegramAudio(audioObj.file_id, audioObj.mime_type || 'audio/ogg');
        const transcript = media ? await transcribeAudio(media.base64, media.mimeType) : '';
        const cleanTranscript = String(transcript || '').trim();
        if (!cleanTranscript) {
          await sendMessage(chatId, '⚠️ Não consegui transcrever esse áudio. Pode repetir ou enviar em texto?');
          return;
        }
        const combined = rawText ? `${rawText}\n${cleanTranscript}` : cleanTranscript;
        await runOwnerTurn({ chatId, text: combined, pushName, messageId });
      } catch (err) {
        safeLogError('[telegram] Falha ao processar áudio:', err);
        await sendMessage(chatId, '⚠️ Tive um erro ao baixar ou transcrever esse áudio.');
      }
      return;
    }

    if (!parsedCmd.text) return;

    try {
      await runOwnerTurn({ chatId, text: parsedCmd.text, pushName, messageId });
    } catch (err) {
      safeLogError('[telegram] Erro ao processar mensagem do Copiloto:', err);
      await sendMessage(chatId, '⚠️ Ocorreu um erro interno ao processar seu comando. Tente novamente em instantes.').catch(() => {});
    }
  }

  async function handleCallbackQuery(query) {
    const chatId = query?.message?.chat?.id;
    const callbackId = query?.id;
    if (chatId === undefined || chatId === null || !callbackId) return;
    const chatIdStr = String(chatId);
    const adminIds = currentAdminIds();
    if (!adminIds.includes(chatIdStr)) {
      await apiCall('answerCallbackQuery', { callback_query_id: callbackId, text: 'Não autorizado.' }).catch(() => {});
      return;
    }
    const data = String(query.data || '');
    const pushName = [query.from?.first_name, query.from?.last_name].filter(Boolean).join(' ').trim() || query.from?.username || '';

    if (data === 'outbound:approve' || data === 'outbound:cancel') {
      const label = data === 'outbound:approve' ? 'Aprovando disparo...' : 'Cancelando disparo...';
      await apiCall('answerCallbackQuery', { callback_query_id: callbackId, text: label }).catch(() => {});
      if (query.message?.message_id) {
        await apiCall('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [] }
        }).catch(() => {});
      }
      const commandText = data === 'outbound:approve' ? 'sim, aprovar disparo' : 'cancelar disparo';
      try {
        await runOwnerTurn({ chatId, text: commandText, pushName, messageId: `cb:${callbackId}` });
      } catch (err) {
        safeLogError('[telegram] Erro ao processar callback:', err);
      }
      return;
    }

    await apiCall('answerCallbackQuery', { callback_query_id: callbackId }).catch(() => {});
  }

  async function handleUpdate(update) {
    if (!update || typeof update !== 'object') return;
    lastUpdateAt = new Date().toISOString();
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  }

  async function pollLoop() {
    if (polling) return;
    polling = true;
    while (running) {
      const token = activeToken;
      if (!token) break;
      pollAbortController = new AbortController();
      try {
        const updates = await apiCall('getUpdates', {
          offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message', 'callback_query']
        }, {
          token,
          signal: pollAbortController.signal,
          timeoutMs: (POLL_TIMEOUT_SECONDS + 10) * 1000
        });
        backoffMs = 2000;
        lastError = null;
        if (status !== 'connected') status = 'connected';
        if (Array.isArray(updates)) {
          for (const upd of updates) {
            if (Number.isFinite(upd?.update_id)) {
              offset = Math.max(offset, upd.update_id + 1);
            }
            await handleUpdate(upd);
          }
        }
      } catch (err) {
        if (!running || err?.name === 'AbortError') break;
        lastError = redactSecrets(err?.message || 'poll_error');
        status = 'degraded';
        safeLogError('[telegram] Erro no long-polling:', err);
        const waitMs = backoffMs;
        backoffMs = Math.min(30000, backoffMs * 2);
        await new Promise((resolve) => {
          retryTimer = setTimeout(resolve, waitMs);
          retryTimer.unref?.();
        });
      } finally {
        pollAbortController = null;
      }
    }
    polling = false;
  }

  async function start() {
    const token = currentToken();
    if (!token) {
      status = 'not_configured';
      botUsername = '';
      botId = null;
      activeToken = '';
      lastError = null;
      return getStatus();
    }
    if (running && activeToken === token) return getStatus();
    await stop();
    activeToken = token;
    status = 'connecting';
    lastError = null;
    try {
      const me = await apiCall('getMe', {}, { token, timeoutMs: 12000 });
      botUsername = String(me?.username || '');
      botId = me?.id || null;
      await apiCall('setMyCommands', { commands: TELEGRAM_COMMANDS }, { token, timeoutMs: 12000 }).catch((err) => {
        safeLogError('[telegram] Falha ao registrar menu de comandos:', err);
      });
      running = true;
      status = 'connected';
      logger.log?.(`[telegram] Copiloto conectado como @${botUsername || 'bot'} (admin configurado: ${currentAdminIds().length > 0 ? 'sim' : 'pendente /meu_id'}).`);
      void pollLoop();
    } catch (err) {
      running = false;
      status = 'error';
      lastError = redactSecrets(err?.message || 'start_failed');
      safeLogError('[telegram] Falha ao iniciar bot:', err);
    }
    return getStatus();
  }

  async function stop() {
    running = false;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (pollAbortController) {
      try { pollAbortController.abort(); } catch {}
      pollAbortController = null;
    }
    activeToken = '';
    if (status !== 'not_configured') status = 'stopped';
  }

  async function reload() {
    const token = currentToken();
    if (!token) {
      await stop();
      status = 'not_configured';
      botUsername = '';
      botId = null;
      return getStatus();
    }
    if (!running || activeToken !== token) {
      return await start();
    }
    return getStatus();
  }

  async function notifyAdmin(text, { withApprovalButtons = false } = {}) {
    const token = currentToken();
    const adminIds = currentAdminIds();
    if (!token || !adminIds.length) return { sent: 0 };
    const clean = String(text || '').trim();
    if (!clean) return { sent: 0 };
    let sent = 0;
    for (const chatId of adminIds) {
      try {
        await sendMessage(chatId, clean, {
          token,
          replyMarkup: withApprovalButtons ? APPROVAL_KEYBOARD : undefined
        });
        sent += 1;
      } catch (err) {
        safeLogError(`[telegram] Falha ao espelhar notificação para ${chatId}:`, err);
      }
    }
    return { sent };
  }

  function getStatus() {
    const configured = Boolean(currentToken());
    const adminIds = currentAdminIds();
    return {
      configured,
      status: configured ? status : 'not_configured',
      botUsername: botUsername || '',
      botId,
      adminConfigured: adminIds.length > 0,
      adminCount: adminIds.length,
      lastError,
      lastUpdateAt
    };
  }

  return {
    start,
    stop,
    reload,
    getStatus,
    notifyAdmin,
    handleUpdate,
    sendMessage
  };
}
