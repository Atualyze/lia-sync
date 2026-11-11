import { normalize } from './safety.mjs';
import { resolveIdentity, isOwnerContact, OWNER_SELF_KEY } from './core/identity.mjs';
import { resolveMessages } from './core/messages.mjs';
import { handleOwnerSession } from './flow/owner.mjs';
import { handleClientMessage } from './flow/client.mjs';
import { formatOutgoingMessage } from './core/format.mjs';

export {
  collectedValid, isHumanRequest, isTalkToTauanRequest, isAtendimentoOption,
  cleanForSpeech, escapeText, stripBotMention, stripCommandPrefix,
  buildFriendlyAudioScript, buildFriendlyMessage, humanizeContactMessage,
  applyAudioCorrection, extractDispatchIntent
} from './flow/text.mjs';

export function createFlow({
  store,
  ai,
  whatsapp = {},
  faq = async () => [],
  getBotConfig = () => ({}),
  now = () => Date.now(),
  humanPhone = '',
  getHumanPhone = () => humanPhone,
  reminderStore = null,
  getTelemetry = async () => ({}),
  allowClientResume = false,
  maxInputChars = 2000,
  rateLimitMax = 20,
  rateLimitWindowMs = 600000,
  logger = console
}) {
  const dedupe = new Map();
  const rate = new Map();
  const rateWarned = new Map();
  const nonTextNotice = new Map();

  const notify = async (message) => {
    const phone = getHumanPhone();
    try {
      if (store?.get) {
        const sSelf = store.get(OWNER_SELF_KEY);
        if (sSelf) {
          sSelf.history ??= [];
          sSelf.history.push({
            role: 'assistant',
            content: message,
            createdAt: new Date(now()).toISOString()
          });
          if (sSelf.history.length > 40) sSelf.history = sSelf.history.slice(-30);
          sSelf.lastBotAt = new Date(now()).toISOString();
          sSelf.updatedAt = new Date(now()).toISOString();
          store.markDirty?.();
        }
      }
    } catch (e) {
      logger.error?.('[notify:copilot] erro ao salvar notificação no histórico interno:', e.message);
    }
    if (!phone) {
      logger.warn?.('[notify] humanPhone não definido; notificação registrada apenas no painel.');
      return undefined;
    }
    return whatsapp.sendText?.(phone, formatOutgoingMessage(message));
  };

  const identityNow = () => resolveIdentity(getBotConfig() || {});

  const isOwnerSender = (p = '') => isOwnerContact(p, { humanPhone: getHumanPhone(), identity: identityNow() });

  const getWaitingList = () => {
    return Object.values(store.sessions || {}).filter(s =>
      s && s.human && !s.archivedAt && s.phone && s.phone !== OWNER_SELF_KEY && !isOwnerSender(s.phone)
    ).sort((a, b) => {
      const tA = a.handoffAt ? new Date(a.handoffAt).getTime() : 0;
      const tB = b.handoffAt ? new Date(b.handoffAt).getTime() : 0;
      return tA - tB;
    });
  };

  const findSessionByTarget = (targetStr = '') => {
    const raw = String(targetStr || '').trim();
    if (!raw) return null;

    const waiting = getWaitingList();

    // 1. Índice numérico da fila (ex: "1", "2")
    if (/^\d{1,2}$/.test(raw)) {
      const idx = parseInt(raw, 10) - 1;
      if (waiting[idx]) return waiting[idx];
    }

    const all = Object.values(store.sessions || {}).filter(s =>
      s && s.phone && s.phone !== OWNER_SELF_KEY && !isOwnerSender(s.phone)
    );

    // 2. Por dígitos (telefone)
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 8) {
      for (const s of all) {
        const sDigits = String(s.phone || '').replace(/\D/g, '');
        if (sDigits === digits || sDigits.endsWith(digits) || digits.endsWith(sDigits)) {
          return s;
        }
      }
      if (store.sessions[digits]) return store.sessions[digits];
      if (store.sessions[`sim:${digits}`]) return store.sessions[`sim:${digits}`];
    }

    // 3. Por nome do contato (busca por substring insensível a maiúsculas e acentos)
    const normName = normalize(raw);
    if (normName.length >= 2) {
      for (const s of all) {
        const cName = normalize(s.clientName || s.contactName || s.pushName || '');
        if (cName && (cName.includes(normName) || normName.includes(cName))) {
          return s;
        }
      }
    }

    // 4. Fallback pelo store.get se for número de telefone completo
    if (digits.length >= 8) {
      return store.get(digits);
    }

    return null;
  };

  return {
    isDuplicate(id) {
      if (!id) return false;
      const t = now();
      for (const [key, value] of dedupe) if (t - value > 600000) dedupe.delete(key);
      if (dedupe.has(id)) return true;
      dedupe.set(id, t);
      if (dedupe.size > 1000) dedupe.delete(dedupe.keys().next().value);
      return false;
    },
    allowRate(phone) {
      if (isOwnerSender(phone) || phone === OWNER_SELF_KEY) return true;
      const fresh = (rate.get(phone) || []).filter(t => now() - t < rateLimitWindowMs);
      if (fresh.length >= rateLimitMax) { rate.set(phone, fresh); return false; }
      fresh.push(now());
      rate.set(phone, fresh);
      return true;
    },
    shouldWarnRate(phone) {
      if (rateWarned.has(phone) && now() - rateWarned.get(phone) < rateLimitWindowMs) return false;
      rateWarned.set(phone, now());
      return true;
    },
    async process({
      phone,
      text,
      origin = 'real',
      nonText = false,
      mediaType = null,
      rawItem = null,
      pushName = '',
      authorizedResume = false,
      messageId = '',
      attachments = []
    }) {
      const botConfig = getBotConfig() || {};
      const identity = resolveIdentity(botConfig);
      const messages = resolveMessages(botConfig);
      const owner = identity.responsible || 'nossa equipe';
      const assistant = identity.botName || 'Lia';
      const ownerLabel = identity.companyName ? `${owner} (${identity.companyName})` : owner;
      const isOwnerSession = phone === OWNER_SELF_KEY || isOwnerSender(phone);

      // ==========================================
      // CASO 1: RESPONSÁVEL INTERAGINDO COM A ASSISTENTE (COPILOTO)
      // ==========================================
      if (isOwnerSession) {
        return handleOwnerSession({
          store, ai, whatsapp, reminderStore, logger, now, getHumanPhone, getTelemetry,
          botConfig, identity, owner, assistant, ownerLabel,
          isOwnerSender, getWaitingList, findSessionByTarget,
          phone, text, origin, nonText, mediaType, rawItem, pushName, authorizedResume, messageId, attachments
        });
      }

      return handleClientMessage({
        store, ai, whatsapp, faq, reminderStore, logger, now,
        allowClientResume, maxInputChars, notify, isOwnerSender,
        botConfig, identity, messages, owner, assistant,
        phone, text, origin, nonText, mediaType, rawItem, pushName, messageId
      });
    }
  };
}
