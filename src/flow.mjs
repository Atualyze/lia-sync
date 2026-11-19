import { normalizePhone } from './sessions.mjs';
import { resolveIdentity, isOwnerContact, OWNER_SELF_KEY } from './core/identity.mjs';
import { resolveMessages } from './core/messages.mjs';
import { handleOwnerSession } from './flow/owner.mjs';
import { handleClientMessage } from './flow/client.mjs';
import { formatOutgoingMessage } from './core/format.mjs';
import { normalize } from './safety.mjs';

export {
  collectedValid, isHumanRequest, isTalkToOwnerRequest, isAtendimentoOption,
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
  // Projeção de runtime dos setores vindos do Chatwoot; nunca duplicada na config publicada.
  getSectors = () => [],
  allowClientResume = false,
  maxInputChars = 2000,
  rateLimitMax = 20,
  rateLimitWindowMs = 600000,
  adminConfig = null,
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

  // Namespaces nunca se misturam: sessões simuladas não são clientes reais.
  const isSimulationSession = (key = '', session = null) =>
    String(key).startsWith('sim:') ||
    session?.origin === 'simulation' ||
    String(session?.phone || '').startsWith('sim:');

  const getWaitingList = () => {
    return Object.entries(store.sessions || {}).filter(([key, s]) =>
      s && !isSimulationSession(key, s) && s.human && !s.archivedAt && s.phone && s.phone !== OWNER_SELF_KEY && !isOwnerSender(s.phone)
    ).map(([, session]) => session).sort((a, b) => {
      const tA = a.handoffAt ? new Date(a.handoffAt).getTime() : 0;
      const tB = b.handoffAt ? new Date(b.handoffAt).getTime() : 0;
      return tA - tB;
    });
  };

  const findSessionByTarget = (targetStr = '', { origin = 'real' } = {}) => {
    const raw = String(targetStr || '').trim();
    if (!raw) return null;

    const wantsSimulation = origin === 'simulation';
    const waiting = getWaitingList();

    // 1. Índice numérico da fila (ex: "1", "2") — a fila contém apenas clientes reais.
    if (!wantsSimulation && /^\d{1,2}$/.test(raw)) {
      const idx = parseInt(raw, 10) - 1;
      if (waiting[idx]) return waiting[idx];
    }

    const all = Object.entries(store.sessions || {}).filter(([key, s]) =>
      s && isSimulationSession(key, s) === wantsSimulation && s.phone && s.phone !== OWNER_SELF_KEY && !isOwnerSender(s.phone)
    ).map(([, session]) => session);

    // 2. Por dígitos (telefone): exato primeiro, ou sufixo único (sem criar sessão fantasma)
    const digits = raw.replace(/\D/g, '');
    const canonicalPhone = digits.length === 10 || digits.length === 11 || /^55\d{10,11}$/.test(digits)
      ? normalizePhone(digits)
      : digits;
    if (digits.length >= 8) {
      const exactDigit = all.find((s) => {
        const sessionDigits = String(s.phone || '').replace(/\D/g, '');
        return sessionDigits === digits || normalizePhone(sessionDigits) === canonicalPhone;
      });
      if (exactDigit) return exactDigit;
      const explicitKeys = [...new Set([
        digits,
        canonicalPhone,
        ...(wantsSimulation ? [`sim:${digits}`, `sim:${canonicalPhone}`] : [])
      ])];
      for (const explicitKey of explicitKeys) {
        if (store.sessions[explicitKey]) return store.sessions[explicitKey];
      }
      const suffixMatches = all.filter((s) => {
        const sDigits = String(s.phone || '').replace(/\D/g, '');
        return sDigits.endsWith(digits) || digits.endsWith(sDigits) || normalizePhone(sDigits) === canonicalPhone;
      });
      if (suffixMatches.length === 1) return suffixMatches[0];
    }

    // 3. Por nome do contato: exato primeiro, depois palavra inteira única (evita "Ana" -> "Mariana")
    const normName = normalize(raw);
    if (normName.length >= 2) {
      const exactName = all.find((s) => normalize(s.clientName || s.contactName || s.pushName || '') === normName);
      if (exactName) return exactName;
      const escaped = normName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wordRe = new RegExp(`\\b${escaped}\\b`, 'i');
      const wordMatches = all.filter((s) => {
        const cName = normalize(s.clientName || s.contactName || s.pushName || '');
        return cName && wordRe.test(cName);
      });
      if (wordMatches.length === 1) return wordMatches[0];
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
      const sectors = typeof getSectors === 'function' ? getSectors() : [];
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
          botConfig, adminConfig, identity, owner, assistant, ownerLabel,
          isOwnerSender, getWaitingList, findSessionByTarget,
          phone, text, origin, nonText, mediaType, rawItem, pushName, authorizedResume, messageId, attachments
        });
      }

      return handleClientMessage({
        store, ai, whatsapp, faq, reminderStore, logger, now,
        allowClientResume, maxInputChars, notify, isOwnerSender,
        botConfig, identity, messages, owner, assistant, sectors,
        phone, text, origin, nonText, mediaType, rawItem, pushName, messageId
      });
    }
  };
}
