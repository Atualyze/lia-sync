import path from 'node:path';
import QRCode from 'qrcode';
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers
} from '@whiskeysockets/baileys';
import { createLiaBaileysAuthState, BoundedLruCache } from './baileys-auth.mjs';

const DEDUPE_CACHE_MAX = 600;
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const MAX_MESSAGE_AGE_MS = 45_000;

function toRemoteJid(jid = '') {
  const s = String(jid || '').trim();
  if (!s) return '';
  if (s.includes('@')) return s;
  const digits = s.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

function extractOwnerPhoneFromJid(jid = '') {
  const raw = String(jid || '').trim();
  if (!raw) return '';
  return raw.split(':')[0].split('@')[0].replace(/\D/g, '');
}

const silentLogger = {
  level: 'silent',
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() { return silentLogger; }
};

/**
 * Message Gate ultra-rápido (P0):
 * Filtra eventos irrelevantes, status@broadcast, grupos, canais, sincronizações
 * de histórico, reações vazias e mensagens duplicadas ANTES do webhook ledger,
 * do Context Builder e do AI Orchestrator.
 */
export function evaluateBaileysMessageGate(msg, { type = 'notify', seenCache = null, nowMs = Date.now() } = {}) {
  if (!msg || typeof msg !== 'object' || !msg.key) {
    return { allowed: false, reason: 'missing_key' };
  }
  // 1. Só aceita mensagens em tempo real ('notify'), descartando lotes de histórico ('append')
  if (type !== 'notify') {
    return { allowed: false, reason: 'history_append_ignored' };
  }

  const remoteJid = String(msg.key.remoteJid || '').trim();
  if (!remoteJid) {
    return { allowed: false, reason: 'empty_jid' };
  }

  // 2. Descarta status, broadcasts, grupos e canais (newsletters) na porta de entrada
  if (
    remoteJid === 'status@broadcast' ||
    /@(?:broadcast|g\.us|newsletter)$/i.test(remoteJid)
  ) {
    return { allowed: false, reason: 'non_direct_chat' };
  }

  // 3. Descarta eventos de sistema sem conteúdo conversacional ou de revogação real
  const m = msg.message;
  if (!m || typeof m !== 'object') {
    return { allowed: false, reason: 'empty_message_envelope' };
  }
  if (
    m.protocolMessage &&
    m.protocolMessage.type !== 0 &&
    m.protocolMessage.type !== 'REVOKE'
  ) {
    return { allowed: false, reason: 'non_revoke_protocol_message' };
  }
  if (
    m.reactionMessage ||
    m.pollUpdateMessage ||
    m.keepInChatMessage ||
    m.pinInChatMessage ||
    m.ephemeralMessage?.message?.protocolMessage
  ) {
    return { allowed: false, reason: 'ephemeral_or_reaction_ignored' };
  }

  const hasUsablePayload = Boolean(
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage ||
    m.audioMessage ||
    m.videoMessage ||
    m.documentMessage ||
    m.documentWithCaptionMessage?.message?.documentMessage ||
    (m.protocolMessage && (m.protocolMessage.type === 0 || m.protocolMessage.type === 'REVOKE'))
  );
  if (!hasUsablePayload) {
    return { allowed: false, reason: 'unsupported_message_type' };
  }

  // 4. Descarta mensagens antigas reentregues pelo servidor (> 45s)
  const rawTs = Number(msg.messageTimestamp || 0);
  if (Number.isFinite(rawTs) && rawTs > 0) {
    const msgMs = rawTs < 1e12 ? rawTs * 1000 : rawTs;
    if (nowMs - msgMs > MAX_MESSAGE_AGE_MS) {
      return { allowed: false, reason: 'stale_message' };
    }
  }

  // 5. Deduplicação O(1) em memória limitada (evita bater no Supabase para retry de frame)
  const msgId = String(msg.key.id || '').trim();
  if (msgId && seenCache) {
    const dedupeKey = `${remoteJid}:${msgId}`;
    if (seenCache.get(dedupeKey)) {
      return { allowed: false, reason: 'duplicate_frame' };
    }
    seenCache.set(dedupeKey, true);
  }

  return { allowed: true, reason: 'accepted' };
}

export class BaileysProvider {
  constructor({
    authDir = './data/baileys-auth',
    client = null,
    onEvent = null,
    onStateChange = null,
    logger = console
  } = {}) {
    this.authDir = path.resolve(authDir);
    this.client = client;
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.logger = logger;

    this.sock = null;
    this.authController = null;
    this.status = 'disconnected'; // disconnected | connecting | qr_ready | connected | logged_out | error
    this.qrText = '';
    this.qrDataUrl = '';
    this.pairingCode = '';
    this.connectedPhone = '';
    this.connectedName = '';
    this.lastMessageAt = null;
    this.lastConnectedAt = null;
    this.lastError = null;
    this.messagesReceived = 0;
    this.messagesSent = 0;
    this.messagesFiltered = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.manualStop = false;
    this.starting = false;
    this.seenMessages = new BoundedLruCache({ max: DEDUPE_CACHE_MAX, ttlMs: DEDUPE_TTL_MS });
  }

  getStatus() {
    const mem = process.memoryUsage();
    const cacheStats = this.authController?.getCacheStats?.() || {
      ephemeralKeysInRam: 0,
      persistedSessions: 0,
      persistedPreKeys: 0
    };
    return {
      provider: 'baileys',
      status: this.status,
      connected: this.status === 'connected',
      phone: this.connectedPhone || null,
      name: this.connectedName || null,
      qrDataUrl: this.status === 'qr_ready' ? this.qrDataUrl : null,
      pairingCode: this.pairingCode || null,
      lastMessageAt: this.lastMessageAt,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      stats: {
        messagesReceived: this.messagesReceived,
        messagesSent: this.messagesSent,
        messagesFiltered: this.messagesFiltered,
        dedupeCacheSize: this.seenMessages.size,
        ...cacheStats,
        rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
        heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10
      }
    };
  }

  _emitState() {
    try {
      this.onStateChange?.(this.getStatus());
    } catch {}
  }

  _nextBackoffMs() {
    const attempt = Math.min(6, this.reconnectAttempts++);
    const base = Math.min(30_000, 1500 * (2 ** attempt));
    const jitter = Math.floor(Math.random() * 800);
    return base + jitter;
  }

  async start() {
    if (this.starting || this.status === 'connected') return this.getStatus();
    this.starting = true;
    this.manualStop = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      this.status = 'connecting';
      this.lastError = null;
      this._emitState();

      this.authController = await createLiaBaileysAuthState({
        authDir: this.authDir,
        client: this.client,
        logger: this.logger
      });
      const { state, saveCreds, clearAuth } = this.authController;

      if (state.creds?.me?.id) {
        this.connectedPhone = extractOwnerPhoneFromJid(state.creds.me.id);
        this.connectedName = state.creds.me.name || state.creds.me.verifiedName || this.connectedName || 'WhatsApp Lia';
      }

      if (this.sock) {
        const old = this.sock;
        this.sock = null;
        try { old.ev?.removeAllListeners?.(); old.end?.(undefined); } catch {}
      }

      let version = [2, 3000, 1017531287];
      try {
        const latest = await fetchLatestBaileysVersion();
        if (Array.isArray(latest?.version)) version = latest.version;
      } catch {}

      const sock = makeWASocket({
        version,
        auth: state,
        logger: silentLogger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Lia Sync'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: (jid) => !jid || jid === 'status@broadcast' || /@(?:broadcast|g\.us|newsletter)$/i.test(jid),
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined
      });

      this.sock = sock;

      sock.ev.on('creds.update', async () => {
        try {
          if (state.creds?.me?.id) {
            this.connectedPhone = extractOwnerPhoneFromJid(state.creds.me.id);
            this.connectedName = state.creds.me.name || state.creds.me.verifiedName || this.connectedName || 'WhatsApp Lia';
          }
          await saveCreds();
          this._emitState();
        } catch {}
      });

      sock.ev.on('connection.update', async (update) => {
        if (this.sock !== sock) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr && !state.creds?.registered && !state.creds?.me?.id) {
          this.qrText = qr;
          try {
            this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 280 });
          } catch {
            this.qrDataUrl = '';
          }
          this.status = 'qr_ready';
          this._emitState();
        }

        if (connection === 'open') {
          this.status = 'connected';
          this.reconnectAttempts = 0;
          this.qrText = '';
          this.qrDataUrl = '';
          this.pairingCode = '';
          this.lastConnectedAt = new Date().toISOString();
          this.lastError = null;
          const user = sock.user || state.creds?.me || {};
          this.connectedPhone = extractOwnerPhoneFromJid(user.id || '') || this.connectedPhone;
          this.connectedName = user.name || user.verifiedName || this.connectedName || 'WhatsApp Lia';
          await saveCreds();
          this._emitState();
          void this.onEvent?.({
            event: 'CONNECTION_UPDATE',
            instance: 'baileys',
            data: { state: 'open', ownerJid: user.id || '' }
          });
        }

        if (connection === 'close') {
          const statusCode = Number(
            lastDisconnect?.error?.output?.statusCode
            || lastDisconnect?.error?.statusCode
            || 0
          );
          const rawMsg = String(lastDisconnect?.error?.message || '');
          const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
          const isRestartRequired = statusCode === DisconnectReason.restartRequired
            || statusCode === 515
            || /restart required|stream errored/i.test(rawMsg);
          this.qrText = '';
          this.qrDataUrl = '';
          if (isLoggedOut) {
            this.status = 'logged_out';
            this.connectedPhone = '';
            this.connectedName = '';
            this.lastError = 'Sessão desconectada pelo aparelho. Escaneie um novo QR Code.';
            await clearAuth();
            this._emitState();
            return;
          }
          if (isRestartRequired && !this.manualStop) {
            this.status = 'connecting';
            this.lastError = null;
            this._emitState();
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              void this.start().catch(() => {});
            }, 350);
            this.reconnectTimer.unref?.();
            return;
          }
          this.status = 'disconnected';
          this.lastError = rawMsg || `Conexão encerrada (${statusCode || 'socket_closed'})`;
          this._emitState();
          if (!this.manualStop) {
            const delayMs = this._nextBackoffMs();
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              void this.start().catch(() => {});
            }, delayMs);
            this.reconnectTimer.unref?.();
          }
        }
      });

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (this.sock !== sock) return;
        if (this.status !== 'connected') {
          this.status = 'connected';
          this.qrText = '';
          this.qrDataUrl = '';
          this.lastError = null;
        }
        for (const msg of Array.isArray(messages) ? messages : []) {
          const gate = evaluateBaileysMessageGate(msg, {
            type,
            seenCache: this.seenMessages
          });
          if (!gate.allowed) {
            this.messagesFiltered += 1;
            continue;
          }
          this.messagesReceived += 1;
          this.lastMessageAt = new Date().toISOString();
          this._emitState();
          if (typeof this.onEvent === 'function') {
            const normalizedMsg = msg.message?.documentWithCaptionMessage?.message
              ? { ...msg.message, documentMessage: msg.message.documentWithCaptionMessage.message.documentMessage }
              : (msg.message || {});
            void Promise.resolve(this.onEvent({
              event: 'MESSAGES_UPSERT',
              instance: 'baileys',
              data: {
                key: msg.key,
                message: normalizedMsg,
                pushName: msg.pushName || '',
                messageTimestamp: msg.messageTimestamp
              }
            })).catch(err => this.logger.error?.('[baileys] Erro no processamento de mensagem:', err?.message || err));
          }
        }
      });

      sock.ev.on('messages.update', async (updates) => {
        if (this.sock !== sock) return;
        for (const u of Array.isArray(updates) ? updates : []) {
          if (!u?.key?.remoteJid || /@(?:broadcast|g\.us|newsletter)$/i.test(u.key.remoteJid)) continue;
          if (u?.update?.messageStubType === 'REVOKE' || u?.update?.status === 'DELETED') {
            void this.onEvent?.({
              event: 'MESSAGES_UPDATE',
              instance: 'baileys',
              data: { key: u.key, update: u.update, status: 'DELETED' }
            });
          }
        }
      });

      sock.ev.on('chats.delete', async (deletedIds) => {
        if (this.sock !== sock) return;
        void this.onEvent?.({
          event: 'CHATS_DELETE',
          instance: 'baileys',
          data: deletedIds
        });
      });

      return this.getStatus();
    } catch (error) {
      this.status = 'error';
      this.lastError = error?.message || 'Falha ao iniciar Baileys';
      this._emitState();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async requestPairingCode(phoneNumber = '') {
    const cleanPhone = String(phoneNumber || '').replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      throw new Error('Informe o número completo com DDI e DDD (ex: 5588999999999).');
    }
    if (!this.sock || this.status === 'disconnected' || this.status === 'logged_out') {
      await this.start();
    }
    if (!this.sock?.requestPairingCode) {
      throw new Error('Socket Baileys ainda não está pronto para gerar código de pareamento.');
    }
    const code = await this.sock.requestPairingCode(cleanPhone);
    this.pairingCode = String(code || '').trim();
    this._emitState();
    return this.pairingCode;
  }

  async stop({ logout = false } = {}) {
    this.manualStop = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const current = this.sock;
    this.sock = null;
    if (current) {
      try {
        current.ev?.removeAllListeners?.();
        if (logout) await current.logout();
        else current.end?.(undefined);
      } catch {}
    }
    if (logout) {
      await this.authController?.clearAuth?.();
      this.connectedPhone = '';
      this.connectedName = '';
      this.seenMessages.clear();
    }
    this.qrText = '';
    this.qrDataUrl = '';
    this.pairingCode = '';
    this.status = logout ? 'logged_out' : 'disconnected';
    this._emitState();
    return this.getStatus();
  }

  _requireConnected() {
    if (!this.sock || (this.status !== 'connected' && !this.connectedPhone)) {
      throw Object.assign(new Error('Baileys não conectado'), { code: 'baileys_not_connected' });
    }
    if (this.status !== 'connected' && this.connectedPhone) {
      this.status = 'connected';
      this.qrText = '';
      this.qrDataUrl = '';
    }
    return this.sock;
  }

  async sendText(jid, text) {
    const sock = this._requireConnected();
    const remoteJid = toRemoteJid(jid);
    const res = await sock.sendMessage(remoteJid, { text: String(text || '') });
    this.messagesSent += 1;
    this.lastMessageAt = new Date().toISOString();
    this._emitState();
    return { result: res, id: res?.key?.id };
  }

  async sendDocument(jid, { cleanB64, fileName = 'documento.pdf', mimetype = 'application/pdf', caption = '' }) {
    const sock = this._requireConnected();
    const remoteJid = toRemoteJid(jid);
    const buffer = Buffer.from(cleanB64, 'base64');
    const res = await sock.sendMessage(remoteJid, {
      document: buffer,
      fileName,
      mimetype,
      ...(caption ? { caption } : {})
    });
    this.messagesSent += 1;
    this.lastMessageAt = new Date().toISOString();
    this._emitState();
    return { result: res, id: res?.key?.id };
  }

  async sendImage(jid, { cleanB64, mimetype = 'image/png', caption = '' }) {
    const sock = this._requireConnected();
    const remoteJid = toRemoteJid(jid);
    const buffer = Buffer.from(cleanB64, 'base64');
    const res = await sock.sendMessage(remoteJid, {
      image: buffer,
      mimetype,
      ...(caption ? { caption } : {})
    });
    this.messagesSent += 1;
    this.lastMessageAt = new Date().toISOString();
    this._emitState();
    return { result: res, id: res?.key?.id };
  }

  async sendWhatsAppAudio(jid, cleanB64) {
    const sock = this._requireConnected();
    const remoteJid = toRemoteJid(jid);
    const buffer = Buffer.from(cleanB64, 'base64');
    const isWav = buffer.subarray(0, 4).toString('ascii') === 'RIFF';
    const res = await sock.sendMessage(remoteJid, {
      audio: buffer,
      mimetype: isWav ? 'audio/wav' : 'audio/ogg; codecs=opus',
      ptt: true
    });
    this.messagesSent += 1;
    this.lastMessageAt = new Date().toISOString();
    this._emitState();
    return { result: res, id: res?.key?.id };
  }

  async sendPresence(jid, presence = 'composing') {
    if (!this.sock || this.status !== 'connected') return;
    try {
      await this.sock.sendPresenceUpdate(presence, toRemoteJid(jid));
    } catch {}
  }

  async getMediaBase64(item) {
    if (!item?.message) return null;
    try {
      const buffer = await downloadMediaMessage(
        { key: item.key, message: item.message },
        'buffer',
        {},
        {
          logger: silentLogger,
          reuploadRequest: this.sock?.updateMediaMessage
        }
      );
      if (!buffer) return null;
      const m = item.message;
      const mimetype = m.audioMessage?.mimetype
        || m.imageMessage?.mimetype
        || m.videoMessage?.mimetype
        || m.documentMessage?.mimetype
        || 'application/octet-stream';
      return { base64: Buffer.from(buffer).toString('base64'), mimetype };
    } catch (error) {
      this.logger.error?.('[baileys:media] Falha ao baixar mídia:', error?.message || error);
      return null;
    }
  }

  async markChatAsRead({ jid, messageId, fromMe = false } = {}) {
    if (!this.sock || this.status !== 'connected' || !jid || !messageId) return { ok: false };
    try {
      await this.sock.readMessages([{ remoteJid: toRemoteJid(jid), id: String(messageId), fromMe: Boolean(fromMe) }]);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
}
