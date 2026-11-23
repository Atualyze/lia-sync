import { normalizePhone } from './sessions.mjs';
import { resolveIdentity, isOwnerContact, OWNER_SELF_KEY } from './core/identity.mjs';
import { resolveMessages } from './core/messages.mjs';
import { handleOwnerSession } from './flow/owner.mjs';
import { handleClientMessage } from './flow/client.mjs';
import { formatOutgoingMessage } from './core/format.mjs';
import { normalize } from './safety.mjs';
import { isHumanHandoffActive } from './flow/human-handoff-state.mjs';

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
  operationsStore = null,
  copilotTaskStore = null,
  liaRuntime = null,
  getTelemetry = async () => ({}),
  // Projeção de runtime dos setores vindos do Chatwoot; nunca duplicada na config publicada.
  getSectors = () => [],
  allowClientResume = false,
  maxInputChars = 2000,
  rateLimitMax = 20,
  rateLimitWindowMs = 600000,
  adminConfig = null,
  onOwnerNotify = null,
  logger = console
}) {
  const dedupe = new Map();
  const rate = new Map();
  const rateWarned = new Map();
  const OWNER_HISTORY_LIMIT = 100;

  const notify = async (message) => {
    const phone = getHumanPhone();
    try {
      if (store?.get) {
        const recordNotification = async () => {
          const sSelf = store.get(OWNER_SELF_KEY);
          if (!sSelf) return;
          sSelf.history ??= [];
          sSelf.history.push({
            role: 'assistant',
            content: message,
            createdAt: new Date(now()).toISOString()
          });
          if (sSelf.history.length > OWNER_HISTORY_LIMIT) {
            sSelf.history = sSelf.history.slice(-OWNER_HISTORY_LIMIT);
          }
          sSelf.lastBotAt = new Date(now()).toISOString();
          sSelf.updatedAt = new Date(now()).toISOString();
          store.markDirty?.();
        };
        if (typeof store.enqueue === 'function') await store.enqueue(OWNER_SELF_KEY, recordNotification);
        else await recordNotification();
      }
    } catch (e) {
      logger.error?.('[notify:copilot] erro ao salvar notificação no histórico interno:', e.message);
    }
    if (typeof onOwnerNotify === 'function') {
      void Promise.resolve(onOwnerNotify(message)).catch(() => {});
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
      s && !isSimulationSession(key, s) && isHumanHandoffActive(s) && !s.archivedAt && s.phone && s.phone !== OWNER_SELF_KEY && !isOwnerSender(s.phone)
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
    // Chamado pelo webhook somente quando o processamento falhou antes de
    // iniciar uma entrega ao WhatsApp. Falhas de entrega permanecem deduplicadas
    // porque o resultado remoto pode ser incerto.
    releaseDuplicate(id) {
      if (!id) return false;
      return dedupe.delete(id);
    },
    allowRate(phone) {
      if (isOwnerSender(phone) || phone === OWNER_SELF_KEY) return true;
      const t = now();
      if (rate.size > 500) {
        for (const [key, timestamps] of rate) {
          const active = timestamps.filter(ts => t - ts < rateLimitWindowMs);
          if (!active.length) rate.delete(key);
          else if (active.length !== timestamps.length) rate.set(key, active);
        }
      }
      const fresh = (rate.get(phone) || []).filter(ts => t - ts < rateLimitWindowMs);
      if (fresh.length >= rateLimitMax) { rate.set(phone, fresh); return false; }
      fresh.push(t);
      rate.set(phone, fresh);
      while (rate.size > 5000) rate.delete(rate.keys().next().value);
      return true;
    },
    shouldWarnRate(phone) {
      const t = now();
      for (const [key, ts] of rateWarned) {
        if (t - ts >= rateLimitWindowMs) rateWarned.delete(key);
        else break;
      }
      if (rateWarned.has(phone) && t - rateWarned.get(phone) < rateLimitWindowMs) return false;
      rateWarned.set(phone, t);
      while (rateWarned.size > 5000) rateWarned.delete(rateWarned.keys().next().value);
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
      attachments = [],
      contextText = ''
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
          store, ai, whatsapp, reminderStore, operationsStore, copilotTaskStore, liaRuntime, logger, now, getHumanPhone, getTelemetry,
          botConfig, adminConfig, identity, owner, assistant, ownerLabel,
          isOwnerSender, getWaitingList, findSessionByTarget,
          phone, text, origin, nonText, mediaType, rawItem, pushName, authorizedResume, messageId, attachments, contextText
        });
      }

      return handleClientMessage({
        store, ai, whatsapp, faq, reminderStore, operationsStore, logger, now,
        allowClientResume, maxInputChars, notify, isOwnerSender,
        botConfig, identity, messages, owner, assistant, sectors, liaRuntime,
        phone, text, origin, nonText, mediaType, rawItem, pushName, messageId, contextText
      });
    },
    async processPendingAIRetries({ immediate = false, sendReply = null } = {}) {
      const currentNow = now();
      let processed = 0;
      let delivered = 0;
      const entries = Object.entries(store.sessions || {});
      for (const [key, session] of entries) {
        if (!session || isSimulationSession(key, session) || isHumanHandoffActive(session) || session.archivedAt) continue;
        if (!session.phone || session.phone === OWNER_SELF_KEY || isOwnerSender(session.phone)) continue;
        const pending = session.pendingAIRetry;
        if (!pending || !pending.userText) continue;
        const nextRetryMs = Date.parse(pending.nextRetryAt || '');
        if (!immediate && Number.isFinite(nextRetryMs) && currentNow < nextRetryMs) continue;

        const runRetry = async () => {
          const live = store.sessions?.[key] || session;
          if (!live || isHumanHandoffActive(live) || live.archivedAt || !live.pendingAIRetry?.userText) return;
          const retryMeta = { ...live.pendingAIRetry };
          processed += 1;
          const reply = await handleClientMessage({
            store,
            ai,
            whatsapp,
            faq,
            reminderStore,
            operationsStore,
            logger,
            now,
            allowClientResume,
            maxInputChars,
            notify,
            isOwnerSender,
            botConfig: getBotConfig() || {},
            identity: resolveIdentity(getBotConfig() || {}),
            messages: resolveMessages(getBotConfig() || {}),
            owner: (resolveIdentity(getBotConfig() || {}).responsible) || 'nossa equipe',
            assistant: (resolveIdentity(getBotConfig() || {}).botName) || 'Lia',
            sectors: typeof getSectors === 'function' ? getSectors() : [],
            phone: live.phone,
            text: retryMeta.userText,
            origin: 'ai_retry',
            nonText: false,
            mediaType: retryMeta.mediaType || 'text',
            rawItem: { jid: retryMeta.rawJid || live.phone },
            pushName: retryMeta.pushName || live.clientName || '',
            messageId: ''
          });
          if (reply) {
            const target = retryMeta.rawJid || live.phone;
            if (typeof sendReply === 'function') {
              await sendReply(target, reply, live);
            } else if (typeof whatsapp?.sendText === 'function') {
              await whatsapp.sendText(target, formatOutgoingMessage(reply));
            }
            delivered += 1;
          }
        };

        try {
          if (typeof store.enqueue === 'function') {
            await store.enqueue(session.phone, runRetry);
          } else {
            await runRetry();
          }
        } catch (err) {
          logger.error?.(`[flow:ai-retry] Falha ao retentar resposta para ${session.phone}:`, err?.message || err);
        }
      }
      return { processed, delivered };
    }
  };
}
