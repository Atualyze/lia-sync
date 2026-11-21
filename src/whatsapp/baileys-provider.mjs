import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  BufferJSON,
  Browsers
} from '@whiskeysockets/baileys';

const PROJECTION_KEY = 'baileys_auth_creds';

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
    this.reconnectTimer = null;
    this.manualStop = false;
    this.starting = false;
  }

  getStatus() {
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
        messagesSent: this.messagesSent
      }
    };
  }

  _emitState() {
    try {
      this.onStateChange?.(this.getStatus());
    } catch {}
  }

  async _restoreCredsFromSupabase() {
    if (!this.client?.enabled) return false;
    const credsPath = path.join(this.authDir, 'creds.json');
    try {
      await fs.access(credsPath);
      return true; // já existe em disco
    } catch {}

    try {
      const rows = await this.client.select(
        'runtime_projections',
        `select=key,payload&key=eq.${encodeURIComponent(PROJECTION_KEY)}&limit=1`
      );
      const rawJson = rows?.[0]?.payload?.credsJson;
      if (typeof rawJson === 'string' && rawJson.trim().startsWith('{')) {
        await fs.mkdir(this.authDir, { recursive: true });
        await fs.writeFile(credsPath, rawJson, 'utf8');
        this.logger.log?.('[baileys] Credenciais restauradas do Supabase com sucesso.');
        return true;
      }
    } catch (error) {
      this.logger.warn?.(`[baileys] Não foi possível restaurar credenciais do Supabase: ${error?.message || error}`);
    }
    return false;
  }

  async _backupCredsToSupabase() {
    if (!this.client?.enabled) return;
    const credsPath = path.join(this.authDir, 'creds.json');
    try {
      const rawJson = await fs.readFile(credsPath, 'utf8');
      await this.client.upsert('runtime_projections', [{
        key: PROJECTION_KEY,
        payload: { credsJson: rawJson },
        updated_at: new Date().toISOString()
      }], 'key');
    } catch {}
  }

  async _clearAuthStorage() {
    try {
      await fs.rm(this.authDir, { recursive: true, force: true });
    } catch {}
    if (this.client?.enabled) {
      try {
        await this.client.upsert('runtime_projections', [{
          key: PROJECTION_KEY,
          payload: { credsJson: null },
          updated_at: new Date().toISOString()
        }], 'key');
      } catch {}
    }
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

      await fs.mkdir(this.authDir, { recursive: true });
      await this._restoreCredsFromSupabase();

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      // Preenche o número já autenticado a partir das credenciais salvas
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
        generateHighQualityLinkPreview: false
      });

      this.sock = sock;

      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
          if (state.creds?.me?.id) {
            this.connectedPhone = extractOwnerPhoneFromJid(state.creds.me.id);
            this.connectedName = state.creds.me.name || state.creds.me.verifiedName || this.connectedName || 'WhatsApp Lia';
          }
          await this._backupCredsToSupabase();
          this._emitState();
        } catch {}
      });

      sock.ev.on('connection.update', async (update) => {
        if (this.sock !== sock) return;
        const { connection, lastDisconnect, qr } = update;

        // Só exibe QR Code se a sessão ainda não estiver autenticada
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
          this.qrText = '';
          this.qrDataUrl = '';
          this.pairingCode = '';
          this.lastConnectedAt = new Date().toISOString();
          this.lastError = null;
          const user = sock.user || state.creds?.me || {};
          this.connectedPhone = extractOwnerPhoneFromJid(user.id || '') || this.connectedPhone;
          this.connectedName = user.name || user.verifiedName || this.connectedName || 'WhatsApp Lia';
          await this._backupCredsToSupabase();
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
            await this._clearAuthStorage();
            this._emitState();
            return;
          }
          if (isRestartRequired && !this.manualStop) {
            // 515 (Stream Errored / restart required) faz parte do protocolo oficial
            // do WhatsApp logo após o pareamento do QR Code. Reconecta imediatamente sem exibir erro!
            this.status = 'connecting';
            this.lastError = null;
            this._emitState();
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              void this.start().catch(() => {});
            }, 400);
            this.reconnectTimer.unref?.();
            return;
          }
          this.status = 'disconnected';
          this.lastError = rawMsg || `Conexão encerrada (${statusCode || 'socket_closed'})`;
          this._emitState();
          if (!this.manualStop) {
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              void this.start().catch(() => {});
            }, 2500);
            this.reconnectTimer.unref?.();
          }
        }
      });

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (this.sock !== sock) return;
        if (type !== 'notify' && type !== 'append') return;
        // Se mensagens reais estão fluindo pelo socket, a conexão está ativa!
        if (this.status !== 'connected') {
          this.status = 'connected';
          this.qrText = '';
          this.qrDataUrl = '';
          this.lastError = null;
        }
        for (const msg of Array.isArray(messages) ? messages : []) {
          if (!msg?.key) continue;
          // Ignora mensagens antigas sincronizadas em lote no append se não forem recentes
          if (type === 'append') {
            const ts = Number(msg.messageTimestamp || 0);
            const ageMs = ts ? Date.now() - (ts < 1e12 ? ts * 1000 : ts) : 0;
            if (ageMs > 60_000) continue;
          }
          this.messagesReceived += 1;
          this.lastMessageAt = new Date().toISOString();
          this._emitState();
          if (typeof this.onEvent === 'function') {
            void Promise.resolve(this.onEvent({
              event: 'MESSAGES_UPSERT',
              instance: 'baileys',
              data: {
                key: msg.key,
                message: msg.message || {},
                pushName: msg.pushName || '',
                messageTimestamp: msg.messageTimestamp
              }
            })).catch(err => this.logger.error?.('[baileys] Erro no processamento de mensagem:', err?.message || err));
          }
        }
      });

      sock.ev.on('messages.update', async (updates) => {
        for (const u of Array.isArray(updates) ? updates : []) {
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
        if (logout) await current.logout();
        else current.end?.(undefined);
      } catch {}
    }
    if (logout) {
      await this._clearAuthStorage();
      this.connectedPhone = '';
      this.connectedName = '';
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
