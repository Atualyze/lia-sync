import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { timingSafeEqual } from 'node:crypto';
import { config, validateConfig } from './config.mjs';
import { SessionStore, normalizePhone, isValidRealMobilePhone, isTauanContact } from './sessions.mjs';
import { createFlow } from './flow.mjs';
import { splitReply } from './safety.mjs';
import { askAI, getAIMetrics, getCircuitBreakers, resetMetrics, pingAI, OPENROUTER_FREE_MODELS, transcribeAudio, analyzeDocument, searchWebWithGemini, synthesizeVoice } from './ai.mjs';
import { loadFaq, faqAgeSeconds } from './faq.mjs';
import { sendText, parsePayload, isMessageUpsert, isIgnoredJid, wasSentByBot, getMediaBase64, getInstanceOwnerPhone, sendWhatsAppAudio } from './whatsapp.mjs';
import { AI_AGENT_STRUCTURE } from './knowledge.mjs';
import { listKnowledgeBases, getKnowledgeBaseContentSync, saveKnowledgeBase } from './knowledge-bases.mjs';
import { authCache, validPhone, serveStatic } from './dashboard.mjs';
import { processMaintenance } from './maintenance.mjs';
import { AdminConfigStore } from './admin-config.mjs';
import { SupabaseSessionStore, SupabaseAdminConfigStore, createSupabaseRuntime } from './supabase-runtime.mjs';
import { setMetricsPersistenceSink } from './metrics.mjs';
import { ReminderStore } from './reminders.mjs';

const require = createRequire(import.meta.url);
const APP_VERSION = require('../package.json').version;
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function withoutHopByHopHeaders(headers = {}) {
  const result = { ...headers };
  const blocked = new Set(HOP_BY_HOP_HEADERS);
  for (const token of String(result.connection || '').split(',')) {
    if (token.trim()) blocked.add(token.trim().toLowerCase());
  }
  for (const name of blocked) delete result[name];
  delete result.host;
  return result;
}

const bridgeSubscribers = new Set();
export function broadcastBridgeEvent(type, data) {
  if (bridgeSubscribers.size === 0) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of Array.from(bridgeSubscribers)) {
    try {
      res.write(payload);
    } catch {
      bridgeSubscribers.delete(res);
    }
  }
}

export function authorized(req, token = config.webhookToken) { if (!token) return config.allowInsecureWebhook; const a = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')); const b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); }
export async function readBody(req, max = 256 * 1024) { let size = 0; const parts = []; for await (const chunk of req) { size += chunk.length; if (size > max) { const e = Error('payload too large'); e.statusCode = 413; throw e; } parts.push(chunk); } try { return JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { const e = Error('invalid json'); e.statusCode = 400; throw e; } }
export function formatPhoneNumber(raw = '') {
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return raw;
  if (digits.startsWith('55') && digits.length >= 12 && digits.length <= 13) {
    const ddd = digits.slice(2, 4);
    const num = digits.slice(4);
    if (num.length === 9) return `+55 (${ddd}) ${num.slice(0, 5)}-${num.slice(5)}`;
    if (num.length === 8) return `+55 (${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`;
  }
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `+${digits}`;
}

export function formatActivityTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  if (isToday) return timeStr;
  if (isYesterday) return `Ontem ${timeStr}`;
  const dateStr = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  return `${dateStr} ${timeStr}`;
}

export function deliveryTarget(job, defaultPhone = '') {
  if (job?.phone === 'tauan_self' || job?.jid === 'tauan_self') {
    const rawJid = String(job?.jid || '');
    if (rawJid && rawJid !== 'tauan_self') return rawJid;
    return defaultPhone;
  }
  const jid = String(job?.jid || '');
  return /@lid$/i.test(jid) ? String(job?.phone || jid) : (jid || String(job?.phone || ''));
}
function json(res, status, body, origin = '') { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(origin ? { 'access-control-allow-origin': origin } : {}) }); res.end(JSON.stringify(body)); }

const supabaseRuntime = config.supabaseRuntimeEnabled ? createSupabaseRuntime({ url: config.supabaseUrl, serviceRoleKey: config.supabaseServiceRoleKey }) : { enabled: false, client: null };
const defaultStore = supabaseRuntime.enabled ? new SupabaseSessionStore(config.dataFile, { client: supabaseRuntime.client, ttlMs: config.sessionTtlMs }) : new SessionStore(config.dataFile, { ttlMs: config.sessionTtlMs });
const defaultAdminConfig = supabaseRuntime.enabled ? new SupabaseAdminConfigStore(undefined, { client: supabaseRuntime.client }) : new AdminConfigStore();

export async function createApp({ store = defaultStore, flow, dashboardAuth, webhookAuthorize, adminConfig = defaultAdminConfig, chatwootInternalUrl = config.chatwootInternalUrl } = {}) {
  await store.load();
  await adminConfig.load();
  if (!store.client?.enabled) console.warn('[persistence] Supabase runtime desativado: configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; usando fallback local.');
  else if (store.remoteError || adminConfig.remoteError) console.warn(`[persistence] Supabase configurado, mas indisponível: ${store.remoteError || adminConfig.remoteError}`);
  else console.log('[persistence] Supabase runtime ativado e conectado com sucesso.');
  setMetricsPersistenceSink(call => store.recordAICall?.(call));
  const faqFor = (botConfig) => async () => {
    const local = await loadFaq();
    const managed = (botConfig()?.knowledge?.faq || []).filter(item => item?.enabled !== false && item?.answer && Array.isArray(item.keys));
    return [...managed, ...local.filter(item => !managed.some(custom => JSON.stringify(custom.keys) === JSON.stringify(item.keys)))];
  };
  const faqWithAdmin = faqFor(() => adminConfig.active);
  let cachedInstanceOwner = null;
  const updateInstanceOwner = async () => {
    try {
      const owner = await getInstanceOwnerPhone();
      if (owner) cachedInstanceOwner = owner;
    } catch {}
  };
  updateInstanceOwner().catch(() => {});

  const getHumanPhone = () => {
    const humanCfg = adminConfig.active.human || {};
    if (humanCfg.enabled === false) return '';
    if (humanCfg.alertDestination === 'same_as_bot') {
      const botPhone = cachedInstanceOwner || config.humanPhone || '';
      return String(botPhone).replace(/\D/g, '');
    }
    const cfgPhone = String(humanCfg.phone || '').replace(/\D/g, '');
    const isLegacyUnusedPhone = cfgPhone === '558898340085' || cfgPhone === '8898340085';
    const raw = (!isLegacyUnusedPhone && cfgPhone) ? cfgPhone : (cachedInstanceOwner || config.humanPhone || cfgPhone || '');
    return String(raw).replace(/\D/g, '');
  };

  const reminderStore = new ReminderStore(path.join(path.dirname(config.dataFile), 'reminders.json'), { client: supabaseRuntime.client });
  await reminderStore.load();

  const getTelemetry = async () => {
    let evoState = 'desconhecido';
    try {
      const r = await fetch(`${config.evolutionUrl}/instance/fetchInstances`, {
        headers: { apikey: config.evolutionKey }
      });
      if (r.ok) {
        const list = await r.json();
        const inst = list.find(x => x.name === config.evolutionInstance);
        evoState = inst?.connectionStatus || 'open';
        if (inst?.ownerJid) {
          cachedInstanceOwner = inst.ownerJid.replace(/@.*$/, '').replace(/\D/g, '');
        }
      }
    } catch {}

    const activeSessions = Object.values(store.sessions).filter(s => !s.inactivityClosed);
    const waitingContacts = activeSessions.filter(s => s.human).map(s => ({
      name: s.clientName || 'Contato',
      phone: s.phone,
      lastMsg: s.history?.at(-1)?.content || ''
    }));

    return {
      whatsapp: {
        instance: config.evolutionInstance,
        status: evoState
      },
      ai: {
        provider: runtimeAI().provider,
        model: runtimeAI().model,
        circuitBreakers: getCircuitBreakers()
      },
      metrics: {
        uptimeSeconds: Math.round(process.uptime()),
        activeSessions: activeSessions.length,
        waitingForTauan: waitingContacts.length,
        waitingList: waitingContacts.slice(0, 5)
      },
      reminders: {
        pending: reminderStore.listActive().length
      }
    };
  };

  const f = flow || createFlow({
    store,
    ai: { askAI, transcribeAudio, analyzeDocument, searchWebWithGemini, synthesizeVoice },
    faq: faqWithAdmin,
    getBotConfig: () => adminConfig.active,
    whatsapp: { sendText, sendWhatsAppAudio, getMediaBase64 },
    getHumanPhone,
    reminderStore,
    getTelemetry,
    allowClientResume: config.humanAllowClientResume,
    maxInputChars: config.maxInputChars,
    rateLimitMax: config.rateLimitMax,
    rateLimitWindowMs: config.rateLimitWindowMs
  });
  const runtimeAI = () => {
    const provider = adminConfig.active.ai?.activeProvider || (config.geminiKey ? 'gemini' : (config.openrouterKey ? 'openrouter' : 'gemini'));
    const model = adminConfig.active.ai?.activeModel || (provider === 'gemini' ? 'gemini-3.8-flash' : 'nvidia/nemotron-3.5-lightning:free');
    const fallbackModels = (Array.isArray(adminConfig.active.ai?.fallbackModels) && adminConfig.active.ai.fallbackModels.length)
      ? adminConfig.active.ai.fallbackModels
      : ['nvidia/nemotron-3.5-lightning:free'];
    return { provider, model, fallbackModels };
  };
  const auth = dashboardAuth || authCache(); const pending = new Map(); const rateMessage = 'Recebi muitas mensagens em pouco tempo por aqui! ⏳\n\nVou pausar nosso atendimento por alguns minutinhos para organizar tudo com calma. Logo em seguida você já pode escrever novamente! 💛';
  const deliver = (job) => store.enqueue(job.phone, () => f.process({ ...job, messageId: job.keyId || '' })).then(async answer => {
    if (!answer) return;
    const parts = splitReply(answer);
    for (let i = 0; i < parts.length; i++) {
      if (i) await new Promise(resolve => setTimeout(resolve, 1000));
      await sendText(deliveryTarget(job, getHumanPhone()), parts[i]);
      broadcastBridgeEvent('bot_reply', {
        phone: job.phone,
        text: parts[i],
        timestamp: Date.now()
      });
    }
  }).catch(e => { try { const session = store.get(job.phone); if (session) { session.sendFailed = true; store.markDirty(); } } catch {} console.error('[webhook]', e.message); });
  const schedule = (job) => {
    if (job.nonText || job.mediaType === 'audio' || job.mediaType === 'image' || job.mediaType === 'video' || job.phone === 'tauan_self') {
      return deliver(job);
    }
    const old = pending.get(job.phone);
    if (old) {
      clearTimeout(old.timer);
      old.text = `${old.text}\n${job.text}`;
      old.keyId = job.keyId || old.keyId;
      old.timer = setTimeout(() => { pending.delete(job.phone); deliver(old); }, config.debounceMs);
      return;
    }
    job.timer = setTimeout(() => { pending.delete(job.phone); deliver(job); }, config.debounceMs);
    pending.set(job.phone, job);
  };
  const proxyToChatwoot = (req, res, fallback) => {
    let target;
    let incoming;
    try {
      target = new URL(chatwootInternalUrl);
      incoming = new URL(req.url, 'http://localhost');
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('invalid_chatwoot_target');
      if (incoming.pathname.length > 2048 || incoming.search.length > 2048 || /%(?:2f|5c|2e)/i.test(incoming.pathname) || /[\\\u0000-\u001f]/.test(incoming.pathname)) throw new Error('invalid_chatwoot_path');
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) throw new Error('invalid_chatwoot_method');
    } catch {
      if (fallback && !res.headersSent) return fallback();
      return json(res, 400, { error: 'invalid_chatwoot_request' });
    }
    const requestHeaders = withoutHopByHopHeaders(req.headers);
    requestHeaders.host = target.host;
    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request({
      hostname: target.hostname,
      port: target.port || undefined,
      path: incoming.pathname + incoming.search,
      method: req.method,
      headers: requestHeaders,
      timeout: 15000
    }, proxyRes => {
      res.writeHead(proxyRes.statusCode || 200, withoutHopByHopHeaders(proxyRes.headers));
      proxyRes.pipe(res, { end: true });
    });
    proxyReq.on('timeout', () => proxyReq.destroy(new Error('chatwoot_timeout')));
    proxyReq.on('error', err => {
      if (fallback && !res.headersSent) return fallback();
      console.error('[chatwoot-proxy]', err.message);
      if (!res.headersSent) json(res, 502, { error: 'chatwoot_unavailable' });
    });
    res.on('close', () => { if (!res.writableEnded) proxyReq.destroy(); });
    req.pipe(proxyReq, { end: true });
  };
  const isChatwootApiPath = pathname => {
    const roots = ['/api/events', '/api/status', '/api/conversations', '/api/contacts', '/api/knowledge-bases', '/api/triage', '/api/channels', '/api/lia', '/api/webhooks'];
    return roots.some(root => pathname === root || pathname.startsWith(`${root}/`));
  };
  const isVerifiedWebhookEndpoint = (method, pathname) =>
    ['GET', 'POST'].includes(method) && /^\/api\/webhooks\/(?:whatsapp|instagram|messenger|evolution|telegram)$/.test(pathname);
  const isLegacyStaticPath = (pathname) => (
    pathname === '/legacy-dashboard' ||
    pathname === '/conectar.html' ||
    pathname === '/qrcode.png' ||
    pathname === '/app.js' ||
    pathname === '/styles.css' ||
    pathname.startsWith('/vendor/')
  );
  const app = async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': config.dashboardOrigin || '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' }); return res.end(); }
    if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, service: 'clubinho-homevet-bot', version: APP_VERSION, uptime: Math.round(process.uptime()), providers: getCircuitBreakers(), activeProvider: runtimeAI().provider, activeModel: runtimeAI().model, faqAgeSeconds: faqAgeSeconds(), sessions: Object.keys(store.sessions).length, persistence: { runtimeEnabled: Boolean(store.client?.enabled), conversations: store.persistence || 'fallback', conversationsError: store.remoteError || null, config: adminConfig.persistence || 'fallback', configError: adminConfig.remoteError || null } });
    if (isChatwootApiPath(u.pathname)) {
      // Esses endpoints validam assinatura, segredo ou verify token no Chatwoot upstream.
      if (isVerifiedWebhookEndpoint(req.method, u.pathname)) return proxyToChatwoot(req, res);
      const authResult = await auth(req, config);
      const authorizedRequest = typeof authResult === 'object' ? authResult.ok === true : authResult === true;
      if (!authorizedRequest) return json(res, typeof authResult === 'object' ? authResult.status || 401 : 401, { error: 'dashboard_auth_required' });
      return proxyToChatwoot(req, res);
    }
    if (u.pathname === '/api/dashboard/auth/config') return json(res, 200, { supabaseUrl: config.supabaseUrl, publishableKey: config.supabaseKey, captchaSiteKey: config.supabaseCaptchaSiteKey, captchaProvider: config.supabaseCaptchaProvider, allowUnauthenticated: config.allowUnauthenticatedDashboard });
    if (u.pathname.startsWith('/api/dashboard/') || u.pathname.startsWith('/api/admin/')) { const authResult = await auth(req, config); const authorizedRequest = typeof authResult === 'object' ? authResult.ok === true : authResult === true; if (!authorizedRequest) { const status = typeof authResult === 'object' ? authResult.status || 401 : 401; const reason = typeof authResult === 'object' ? authResult.reason || 'dashboard_auth_required' : 'dashboard_auth_required'; return json(res, status, { error: status === 403 ? 'dashboard_profile_not_authorized' : status === 503 ? 'dashboard_auth_unavailable' : 'dashboard_auth_required', reason }); } }
    if (req.method === 'GET' && !u.pathname.startsWith('/api/')) {
      if (isLegacyStaticPath(u.pathname)) {
        if (u.pathname === '/legacy-dashboard') req.url = '/index.html';
        return serveStatic(req, res, config);
      }
      const authResult = await auth(req, config);
      const authorizedRequest = typeof authResult === 'object' ? authResult.ok === true : authResult === true;
      if (!authorizedRequest) return json(res, typeof authResult === 'object' ? authResult.status || 401 : 401, { error: 'dashboard_auth_required' });
      return proxyToChatwoot(req, res, () => serveStatic(req, res, config));
    }
    if (req.method === 'GET' && u.pathname === '/api/dashboard/state') {
      await store.refresh?.();
      const mode = u.searchParams.get('mode') || 'all';
      const sessions = Object.entries(store.sessions)
        .filter(([key]) => mode === 'all' || (mode === 'simulation' ? key.startsWith('sim:') : !key.startsWith('sim:')))
        .map(([key, s]) => {
          const rawPhone = s.phone || key.replace(/^sim:/, '');
          const phoneFormatted = formatPhoneNumber(rawPhone);
          const clientName = (s.clientName || s.contactName || s.pushName || '').trim();
          const displayName = clientName || phoneFormatted;

          const history = Array.isArray(s.history) ? s.history : [];
          const lastMsg = history.length > 0 ? history[history.length - 1] : null;

          let preview = 'Sem mensagens ainda';
          if (lastMsg) {
            const prefix = lastMsg.role === 'assistant' ? 'Lia: ' : '';
            const cleanContent = String(lastMsg.content || '').replace(/\s+/g, ' ').trim();
            preview = prefix + (cleanContent.length > 80 ? cleanContent.slice(0, 80) + '…' : cleanContent);
          }

          const lastActivityIso = lastMsg?.createdAt || s.lastUserAt || s.lastBotAt || s.updatedAt || s.createdAt || new Date().toISOString();
          const lastActivityTime = new Date(lastActivityIso).getTime() || 0;
          const time = formatActivityTime(lastActivityIso);

          return {
            ...s,
            phone: rawPhone,
            phoneFormatted,
            name: displayName,
            displayName,
            clientName,
            origin: s.origin || (key.startsWith('sim:') ? 'simulation' : 'real'),
            human: Boolean(s.human),
            updatedAt: s.updatedAt,
            lastActivityIso,
            lastActivityTime,
            time,
            preview,
            history
          };
        })
        .sort((a, b) => b.lastActivityTime - a.lastActivityTime);

      return json(res, 200, {
        mode,
        persistence: store.persistence || 'fallback',
        persistenceError: store.remoteError || null,
        sessions
      });
    }
    if (req.method === 'POST' && u.pathname === '/api/dashboard/simulate') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
      if (!validPhone(body.phone) || !body.text) return json(res, 400, { error: 'phone_and_text_required' });
      return json(res, 200, { answer: await store.enqueue(body.phone, () => f.process({ phone: body.phone, text: body.text, origin: 'simulation' })) });
    }
    if (req.method === 'POST' && u.pathname === '/api/dashboard/send') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
      if (!validPhone(body.phone) || typeof body.text !== 'string' || !body.text.trim()) {
        return json(res, 400, { error: 'phone_and_text_required' });
      }
      const phone = String(body.phone).trim();
      const text = body.text.trim();
      const session = store.get(phone);
      session.human = true;
      session.humanSource = 'dashboard';
      session.handoffAt = new Date().toISOString();
      session.handoffReason = 'resposta enviada pelo painel';
      session.handoffReminderAt = null;
      if (!Array.isArray(session.history)) session.history = [];
      session.history.push({
        role: 'assistant',
        content: text,
        createdAt: new Date().toISOString()
      });
      session.lastBotAt = new Date().toISOString();
      session.updatedAt = new Date().toISOString();
      store.markDirty();
      let sent = false;
      let sendError = null;
      try {
        await sendText(phone, text);
        sent = true;
      } catch (err) {
        sendError = err.message;
        console.error('[dashboard/send] falha ao enviar WhatsApp:', err.message);
      }
      await store.flush?.().catch(() => {});
      return json(res, 200, { ok: true, sent, error: sendError });
    }
    if (req.method === 'POST' && u.pathname === '/api/bridge/message') {
      const isBridgeAuth = config.allowUnauthenticatedDashboard || (webhookAuthorize ? await webhookAuthorize(req) : authorized(req));
      if (!isBridgeAuth) return json(res, 401, { error: 'unauthorized' });
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
      const rawPhone = String(body.phone || body.senderIdentifier || '').trim();
      const text = String(body.text || body.content || '').trim();
      const pushName = String(body.pushName || body.senderName || '').trim();
      const origin = body.origin === 'simulation' ? 'simulation' : 'real';
      if (!rawPhone || !text) return json(res, 400, { error: 'phone_and_text_required' });
      let digits = rawPhone === 'tauan_self' || rawPhone === 'conv_lia_copilot'
        ? 'tauan_self'
        : rawPhone.replace(/@.*$/, '').replace(/\D/g, '');
      if (digits !== 'tauan_self') {
        if (digits.length < 8) {
          let hash = 0;
          for (let i = 0; i < rawPhone.length; i++) hash = ((hash << 5) - hash + rawPhone.charCodeAt(i)) | 0;
          digits = ('99' + Math.abs(hash).toString().padStart(9, '0')).slice(0, 11);
        } else if (digits.length > 15) {
          digits = digits.slice(0, 15);
        }
      }
      try {
        const reply = await store.enqueue(digits, () => f.process({
          phone: digits,
          text,
          origin,
          pushName,
          attachments: Array.isArray(body.attachments) ? body.attachments : []
        }));
        const session = store.get(digits, origin);
        const lastAudio = session?.lastAudioBase64 || null;
        if (session) session.lastAudioBase64 = null;
        session.updatedAt = new Date().toISOString();
        store.markDirty();
        await store.flush?.().catch(() => {});
        return json(res, 200, {
          ok: true,
          phone: digits,
          reply: reply || null,
          audioBase64: lastAudio,
          mode: session.human ? 'human' : 'bot',
          handoff: Boolean(session.human),
          handoffReason: session.handoffReason || null,
          clientName: session.clientName || session.contactName || pushName || digits
        });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }
    if (req.method === 'POST' && u.pathname === '/api/bridge/mode') {
      const isBridgeAuth = config.allowUnauthenticatedDashboard || (webhookAuthorize ? await webhookAuthorize(req) : authorized(req));
      if (!isBridgeAuth) return json(res, 401, { error: 'unauthorized' });
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
      const rawPhone = String(body.phone || '').trim();
      let digits = rawPhone.replace(/@.*$/, '').replace(/\D/g, '');
      if (digits.length < 8 && rawPhone) {
        let hash = 0;
        for (let i = 0; i < rawPhone.length; i++) hash = ((hash << 5) - hash + rawPhone.charCodeAt(i)) | 0;
        digits = ('99' + Math.abs(hash).toString().padStart(9, '0')).slice(0, 11);
      } else if (digits.length > 15) {
        digits = digits.slice(0, 15);
      }
      if (!digits || !['human', 'bot'].includes(body.mode)) return json(res, 400, { error: 'invalid_mode_or_phone' });
      try {
        const session = store.get(digits);
        const isHuman = body.mode === 'human';
        session.human = isHuman;
        session.humanSource = isHuman ? 'dashboard' : 'resume';
        if (isHuman) {
          session.handoffAt = new Date().toISOString();
          session.handoffReason = body.reason || 'assumido pelo Chatwoot';
        } else {
          session.handoffAt = null;
          session.handoffNotified = false;
          session.handoffReminder1Sent = false;
          session.handoffReminder60Sent = false;
          session.inactivityClosed = false;
        }
        session.handoffReminderAt = null;
        session.updatedAt = new Date().toISOString();
        store.markDirty();
        await store.flush?.().catch(() => {});
        broadcastBridgeEvent('mode_change', {
          phone: digits,
          mode: session.human ? 'human' : 'bot',
          reason: session.handoffReason,
          timestamp: Date.now()
        });
        return json(res, 200, { ok: true, phone: digits, mode: session.human ? 'human' : 'bot', human: session.human });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }
    if (req.method === 'POST' && u.pathname === '/api/bridge/send') {
      const isBridgeAuth = config.allowUnauthenticatedDashboard || (webhookAuthorize ? await webhookAuthorize(req) : authorized(req));
      if (!isBridgeAuth) return json(res, 401, { error: 'unauthorized' });
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
      const rawPhone = String(body.phone || '').trim();
      const text = String(body.text || '').trim();
      const skipSession = Boolean(body.skipSession);
      if (!rawPhone || !text) return json(res, 400, { error: 'phone_and_text_required' });
      const digits = rawPhone.replace(/@.*$/, '').replace(/\D/g, '');
      const targetJid = /@lid$/i.test(rawPhone) ? rawPhone : (digits || rawPhone);
      try {
        if (!skipSession && (digits.length >= 8 || /@lid$/i.test(rawPhone))) {
          const session = store.get(targetJid);
          session.human = true;
          session.humanSource = 'dashboard';
          session.handoffAt = new Date().toISOString();
          session.handoffReason = body.reason || 'atendimento humano via Chatwoot';
          session.handoffReminderAt = null;
          if (!Array.isArray(session.history)) session.history = [];
          session.history.push({
            role: 'assistant',
            content: text,
            createdAt: new Date().toISOString()
          });
          session.lastBotAt = new Date().toISOString();
          session.updatedAt = new Date().toISOString();
          store.markDirty();
        }
        let sent = false;
        let sendError = null;
        try {
          await sendText(targetJid, text);
          sent = true;
        } catch (err) {
          sendError = err.message;
          console.error('[bridge/send] falha ao enviar WhatsApp:', err.message);
        }
        await store.flush?.().catch(() => {});
        if (sent) {
          broadcastBridgeEvent('whatsapp_message', {
            phone: digits || rawPhone,
            jid: targetJid,
            text,
            fromMe: true,
            isHumanAgent: true,
            timestamp: Date.now()
          });
        }
        return json(res, 200, { ok: true, sent, error: sendError });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/bridge/events') {
      const isBridgeAuth = config.allowUnauthenticatedDashboard || (webhookAuthorize ? await webhookAuthorize(req) : authorized(req));
      if (!isBridgeAuth) return json(res, 401, { error: 'unauthorized' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(': connected\n\n');
      bridgeSubscribers.add(res);
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(ping); bridgeSubscribers.delete(res); }
      }, 20000);
      req.on('close', () => {
        clearInterval(ping);
        bridgeSubscribers.delete(res);
      });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/api/bridge/conversations') {
      const isBridgeAuth = config.allowUnauthenticatedDashboard || (webhookAuthorize ? await webhookAuthorize(req) : authorized(req));
      if (!isBridgeAuth) return json(res, 401, { error: 'unauthorized' });
      if (Object.keys(store.sessions).length === 0) {
        await store.refresh?.().catch(() => {});
      }
      const list = Object.entries(store.sessions)
        .filter(([key, s]) => {
          const rawPhone = s?.phone || key;
          return !key.startsWith('sim:') && (key === 'tauan_self' || isValidRealMobilePhone(rawPhone));
        })
        .map(([key, s]) => {
          const rawPhone = s.phone || key;
          const phoneFormatted = formatPhoneNumber(rawPhone);
          const clientName = (s.clientName || s.contactName || s.pushName || '').trim();
          const rawHistory = Array.isArray(s.history) ? s.history : [];
          const history = [];
          for (const m of rawHistory) {
            if (!m || !m.content) continue;
            const text = String(m.content).trim();
            const prev = history[history.length - 1];
            if (prev && prev.role === m.role && String(prev.content).trim() === text) continue;
            history.push(m);
          }
          const lastMsg = history.length > 0 ? history[history.length - 1] : null;
          const lastActivityIso = s.lastUserAt || s.lastBotAt || lastMsg?.createdAt || s.updatedAt || s.createdAt || new Date(0).toISOString();
          const lastActivityTime = new Date(lastActivityIso).getTime() || 0;
          return {
            key,
            phone: rawPhone,
            phoneFormatted,
            clientName: clientName || phoneFormatted,
            mode: s.human ? 'human' : 'bot',
            human: Boolean(s.human),
            handoffReason: s.handoffReason || null,
            handoffAt: s.handoffAt || null,
            supportModeEnabled: Boolean(s.supportModeEnabled),
            knowledgeBaseId: s.knowledgeBaseId || null,
            contactRole: s.contactRole || null,
            contactNotes: s.contactNotes || null,
            updatedAt: lastActivityIso,
            lastActivityTime,
            history
          };
        })
        .sort((a, b) => b.lastActivityTime - a.lastActivityTime);
      return json(res, 200, { ok: true, sessions: list });
    }
    if (req.method === 'GET' && u.pathname === '/api/bridge/knowledge-bases') {
      const isBridgeAuth = config.allowUnauthenticatedDashboard || (webhookAuthorize ? await webhookAuthorize(req) : authorized(req));
      if (!isBridgeAuth) return json(res, 401, { error: 'unauthorized' });
      const id = u.searchParams.get('id');
      if (id) {
        const kb = getKnowledgeBaseContentSync(id);
        if (!kb) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { ok: true, knowledgeBase: kb });
      }
      const bases = await listKnowledgeBases();
      return json(res, 200, { ok: true, knowledgeBases: bases });
    }
    if (req.method === 'POST' && u.pathname === '/api/bridge/knowledge-bases') {
      const isBridgeAuth = config.allowUnauthenticatedDashboard || (webhookAuthorize ? await webhookAuthorize(req) : authorized(req));
      if (!isBridgeAuth) return json(res, 401, { error: 'unauthorized' });
      let body;
      try { body = await readBody(req, 2 * 1024 * 1024); } catch { return json(res, 400, { error: 'invalid_json' }); }
      try {
        const saved = await saveKnowledgeBase({ id: body.id, title: body.title, content: body.content });
        return json(res, 200, { ok: true, knowledgeBase: saved });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }
    if (req.method === 'POST' && u.pathname === '/api/bridge/contact-context') {
      const isBridgeAuth = config.allowUnauthenticatedDashboard || (webhookAuthorize ? await webhookAuthorize(req) : authorized(req));
      if (!isBridgeAuth) return json(res, 401, { error: 'unauthorized' });
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
      const rawPhone = String(body.phone || '').trim();
      const isCopilotKey = rawPhone === 'tauan_self' || rawPhone === 'contact_lia_copilot';
      const digits = isCopilotKey ? 'tauan_self' : normalizePhone(rawPhone.replace(/@.*$/, '').replace(/\D/g, ''));
      if (!isCopilotKey && (!digits || digits.length < 8)) return json(res, 400, { error: 'invalid_phone' });
      try {
        const applyContextToSession = (sess) => {
          if (typeof body.name === 'string' && body.name.trim()) {
            sess.clientName = body.name.trim();
            sess.contactName = body.name.trim();
          }
          if (typeof body.supportModeEnabled === 'boolean') {
            sess.supportModeEnabled = body.supportModeEnabled;
          }
          if (body.knowledgeBaseId !== undefined) {
            sess.knowledgeBaseId = body.knowledgeBaseId ? String(body.knowledgeBaseId).trim() : null;
          }
          if (body.contactRole !== undefined) {
            sess.contactRole = body.contactRole ? String(body.contactRole).trim() : null;
          }
          if (body.contactNotes !== undefined) {
            sess.contactNotes = body.contactNotes ? String(body.contactNotes).trim() : '';
          }
          sess.updatedAt = new Date().toISOString();
        };

        const session = store.get(digits);
        applyContextToSession(session);

        // Aplica também a variações com/sem 9º dígito já existentes em memória
        if (!isCopilotKey && digits.length >= 10) {
          const ddd = digits.startsWith('55') ? digits.slice(2, 4) : digits.slice(0, 2);
          const tail8 = digits.slice(-8);
          for (const [k, existingSess] of Object.entries(store.sessions || {})) {
            if (!existingSess || k === digits) continue;
            const cleanK = k.replace(/^sim:/, '').replace(/\D/g, '');
            const kDdd = cleanK.startsWith('55') ? cleanK.slice(2, 4) : cleanK.slice(0, 2);
            if (kDdd === ddd && cleanK.slice(-8) === tail8) {
              applyContextToSession(existingSess);
            }
          }
        }

        store.markDirty();
        await store.flush?.().catch(() => {});
        return json(res, 200, {
          ok: true,
          phone: digits,
          clientName: session.clientName,
          supportModeEnabled: Boolean(session.supportModeEnabled),
          knowledgeBaseId: session.knowledgeBaseId || null,
          contactRole: session.contactRole || null,
          contactNotes: session.contactNotes || ''
        });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }
    if (req.method === 'POST' && u.pathname === '/api/dashboard/mode') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
      if (!validPhone(body.phone) || !['human', 'bot'].includes(body.mode)) return json(res, 400, { error: 'invalid_mode_or_phone' });
      const session = store.get(body.phone);
      const isHuman = body.mode === 'human';
      session.human = isHuman;
      session.humanSource = isHuman ? 'dashboard' : null;
      if (isHuman) {
        session.handoffAt = new Date().toISOString();
        session.handoffReason = 'modo humano ativado manualmente pelo painel';
      } else {
        session.handoffAt = null;
        session.handoffNotified = false;
        session.handoffReminder1Sent = false;
        session.handoffReminder60Sent = false;
        session.inactivityClosed = false;
      }
      session.handoffReminderAt = null;
      session.updatedAt = new Date().toISOString();
      store.markDirty();
      await store.flush?.().catch(() => {});
      return json(res, 200, { ok: true, human: session.human });
    }
    if (req.method === 'POST' && u.pathname === '/api/dashboard/clear') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
      if (!validPhone(body.phone)) return json(res, 400, { error: 'invalid_phone' });
      const simulation = body.mode === 'simulation' || body.simulation === true;
      if (!simulation && !(body.confirm === true && typeof body.reason === 'string' && body.reason.trim())) return json(res, 400, { error: 'confirm_and_reason_required' });
      if (simulation) await store.archive(`sim:${body.phone}`, body.reason || 'simulação encerrada');
      else await store.archive(body.phone, body.reason);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && u.pathname === '/api/dashboard/config') return json(res, 200, { provider: runtimeAI().provider, model: runtimeAI().model, instance: config.evolutionInstance, faqUrl: Boolean(config.faqUrl), faqCacheSeconds: config.faqCacheSeconds, fallbackModels: runtimeAI().fallbackModels, providers: getCircuitBreakers(), persistence: store.persistence || 'fallback', persistenceError: store.remoteError || null });
    if (req.method === 'GET' && u.pathname === '/api/admin/config') return json(res, 200, { ...adminConfig.snapshot(), persistence: adminConfig.persistence || 'fallback', persistenceError: adminConfig.remoteError || null });
    if (req.method === 'PATCH' && u.pathname === '/api/admin/config/draft') { const body = await readBody(req); const result = adminConfig.updateDraft(body.patch || body, 'dashboard'); return json(res, result.ok ? 200 : 400, result); }
    if (req.method === 'POST' && u.pathname === '/api/admin/config/validate') { const result = adminConfig.updateDraft(adminConfig.draft, 'validator'); return json(res, result.ok ? 200 : 400, { ok: result.ok, errors: result.errors || [] }); }
    if (req.method === 'POST' && u.pathname === '/api/admin/config/preview') {
      const body = await readBody(req);
      if (!validPhone(body.phone) || typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'phone_and_text_required' });
      const previewFile = path.join(os.tmpdir(), `homevet-preview-${process.pid}-${Date.now()}.json`);
      const previewStore = new SessionStore(previewFile, { ttlMs: 10 * 60 * 1000 });
      try {
        await previewStore.load();
        const previewFlow = createFlow({ store: previewStore, ai: { askAI }, faq: faqFor(() => adminConfig.draft), getBotConfig: () => adminConfig.draft, humanPhone: '', allowClientResume: Boolean(adminConfig.draft.behavior?.allowClientResume), maxInputChars: config.maxInputChars, rateLimitMax: config.rateLimitMax, rateLimitWindowMs: config.rateLimitWindowMs });
        const answer = await previewFlow.process({ phone: body.phone, text: body.text.trim(), origin: 'simulation' });
        await previewStore.flush();
        const previewSession = Object.entries(previewStore.sessions).find(([key]) => key.startsWith('sim:'))?.[1] || null;
        return json(res, 200, { ok: true, revision: adminConfig.revision, answer: answer || null, session: previewSession, publishedRevision: adminConfig.revision });
      } finally {
        await fs.rm(previewFile, { force: true }).catch(() => {});
      }
    }
    if (req.method === 'POST' && u.pathname === '/api/admin/config/publish') { const result = await adminConfig.publish('dashboard'); return json(res, result.ok ? 200 : 400, result); }
    if (req.method === 'POST' && u.pathname === '/api/admin/config/rollback') { const body = await readBody(req); const result = await adminConfig.rollback(body.revision, 'dashboard'); return json(res, result.ok ? 200 : 400, result); }
    if (req.method === 'GET' && u.pathname === '/api/dashboard/models') return json(res, 200, { activeProvider: runtimeAI().provider, openrouterModels: OPENROUTER_FREE_MODELS, configuredModel: runtimeAI().model, fallbackModels: runtimeAI().fallbackModels, providers: getCircuitBreakers() });
    if (req.method === 'GET' && u.pathname === '/api/dashboard/agent-structure') return json(res, 200, AI_AGENT_STRUCTURE);
    if (req.method === 'GET' && u.pathname === '/api/dashboard/metrics') {
      const metrics = getAIMetrics();
      const sessions = Object.values(store.sessions);
      return json(res, 200, {
        ...metrics,
        system: {
          uptime: Math.round(process.uptime()),
          activeProvider: runtimeAI().provider,
          activeModel: runtimeAI().model,
          totalSessions: sessions.length,
          realSessions: sessions.filter(s => !s.phone?.startsWith('sim:') && s.origin !== 'simulation').length,
          simSessions: sessions.filter(s => s.phone?.startsWith('sim:') || s.origin === 'simulation').length,
          handoffWaiting: sessions.filter(s => Boolean(s.human)).length
        }
      });
    }
    if (req.method === 'POST' && u.pathname === '/api/dashboard/metrics/reset') {
      resetMetrics();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/dashboard/ping-ai') {
      const body = await readBody(req).catch(() => ({}));
      const active = runtimeAI(); const pingRes = await pingAI(body?.provider || active.provider, body?.model || active.model);
      return json(res, 200, pingRes);
    }
    if (req.method === 'POST' && (u.pathname === '/webhook' || u.pathname === '/webhook/evolution')) {
      if (!(webhookAuthorize ? await webhookAuthorize(req) : authorized(req))) return json(res, 401, { error: 'unauthorized' });
      let payload;
      try { payload = await readBody(req); } catch (e) { return json(res, e.statusCode || 400, { error: e.message }); }
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));

      const item = parsePayload(payload);
      const id = item.key?.id || payload?.data?.key?.id || payload?.key?.id;
      if (config.evolutionInstance && item.instance && item.instance !== config.evolutionInstance) return;

      const rawEvent = String(item.event || payload?.event || payload?.type || '').toUpperCase().replace(/[._]/g, '');
      if (['CONNECTION_UPDATE', 'CONNECTIONUPDATE', 'QRCODE_UPDATED'].includes(rawEvent)) {
        await updateInstanceOwner().catch(() => {});
        return;
      }

      if (!isMessageUpsert(item.event) || isIgnoredJid(item.jid) || !item.phone) return;

      const isTauanSelf = (jid = '', phone = '') => {
        return isTauanContact(jid, getHumanPhone(), cachedInstanceOwner) ||
               isTauanContact(phone, getHumanPhone(), cachedInstanceOwner);
      };

      const isSelfChat = isTauanSelf(item.jid, item.phone);
      const isCallingLiaDirectly = /^lia\b/i.test(String(item.text || '').trim());

      if (item.fromMe) {
        if (!wasSentByBot(id, item.phone, item.text)) {
          await new Promise(r => setTimeout(r, 400));
          if (!wasSentByBot(id, item.phone, item.text)) {
            // Comando inline do operador no chat com o cliente: reativa o bot
            if (/^[!/#]?(?:bot|reativar)\b/i.test(item.text?.trim())) {
              const session = store.get(item.phone);
              session.human = false;
              session.humanSource = 'resume';
              session.handoffAt = null;
              session.handoffReminderAt = null;
              session.handoffReminder1Sent = false;
              session.handoffReminder60Sent = false;
              session.handoffNotified = false;
              session.inactivityClosed = false;
              session.updatedAt = new Date().toISOString();
              store.markDirty();
              await store.flush?.();
              return;
            }

            if (isSelfChat || isCallingLiaDirectly) {
              broadcastBridgeEvent('whatsapp_message', {
                id,
                phone: 'tauan_self',
                jid: item.jid || item.phone,
                text: item.text || '🎤 [Áudio / Mídia]',
                fromMe: false,
                pushName: 'Tauan (Copiloto)',
                timestamp: Date.now()
              });
              schedule({
                phone: 'tauan_self',
                jid: item.jid || item.phone,
                text: item.text,
                nonText: item.nonText,
                mediaType: item.mediaType,
                rawItem: item,
                pushName: 'Tauan',
                keyId: id
              });
              return;
            }
            const session = store.get(item.phone);
            session.human = true;
            session.humanSource = 'takeover';
            session.handoffAt = new Date().toISOString();
            session.takeoverAt = new Date().toISOString();
            session.handoffReason = 'atendente humano respondeu no WhatsApp';
            session.handoffReminderAt = null;
            session.updatedAt = new Date().toISOString();
            if (item.text && item.text.trim()) {
              session.history ??= [];
              session.history.push({ role: 'assistant', content: item.text.trim() });
              if (session.history.length > 40) {
                session.history = session.history.slice(-30);
              }
            }
            store.markDirty();
            await store.flush?.();
            broadcastBridgeEvent('whatsapp_message', {
              id,
              phone: item.phone,
              jid: item.jid,
              text: item.text,
              fromMe: true,
              isHumanAgent: true,
              timestamp: Date.now()
            });
          }
        }
        return;
      }

      if (f.isDuplicate(id)) return;
      if (!f.allowRate(item.phone)) {
        if (f.shouldWarnRate(item.phone)) sendText(item.jid || item.phone, rateMessage).catch(e => console.error('[rate-limit]', e.message));
        return;
      }

      // Se a mensagem recebida veio do Tauan ou chamando a Lia: direciona para o Copiloto Interno
      if (isSelfChat || isCallingLiaDirectly) {
        broadcastBridgeEvent('whatsapp_message', {
          id,
          phone: 'tauan_self',
          jid: item.jid || item.phone,
          text: item.text || '🎤 [Áudio / Mídia]',
          fromMe: false,
          pushName: 'Tauan (Copiloto)',
          timestamp: Date.now()
        });
        schedule({
          phone: 'tauan_self',
          jid: item.jid || item.phone,
          text: item.text,
          nonText: item.nonText,
          mediaType: item.mediaType,
          rawItem: item,
          pushName: 'Tauan',
          keyId: id
        });
        return;
      }

      broadcastBridgeEvent('whatsapp_message', {
        id,
        phone: item.phone,
        jid: item.jid || item.phone,
        text: item.text || '🎤 [Áudio / Mídia recebido]',
        fromMe: false,
        pushName: item.pushName,
        timestamp: Date.now()
      });

      schedule({
        phone: item.phone,
        jid: item.jid || item.phone,
        text: item.text,
        nonText: item.nonText,
        mediaType: item.mediaType,
        rawItem: item,
        pushName: item.pushName,
        keyId: id
      });
      return;
    }
    return json(res, 404, { error: 'not_found' });
  };
  app.store = store; app.flow = f; app.adminConfig = adminConfig; app.reminderStore = reminderStore; app.getHumanPhone = getHumanPhone; return app;
}

import { fileURLToPath } from 'node:url';

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isDirectRun) {
  const errors = validateConfig(); if (errors.length) { console.error(`[config] ${errors.join('; ')}`); process.exit(1); }
  const app = await createApp(); const store = app.store; const server = http.createServer((req, res) => app(req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'internal_error' }); }));
  server.listen(config.port, config.host, () => console.log(`Lia Sync escutando em ${config.host}:${config.port}`));
  const maintenance = () => processMaintenance({
    store,
    send: sendText,
    notify: app.getHumanPhone() ? message => sendText(app.getHumanPhone(), message) : undefined,
    reminderStore: app.reminderStore,
    timeZone: config.businessTimeZone,
    staleHours: config.inactivityStaleHours,
    humanReminderMinutes: config.humanReminderMinutes,
    humanAutoResumeHours: config.humanAutoResumeHours,
    humanPhone: app.getHumanPhone(),
    disableInactivityPings: true,
    enableLeadFollowUp: Boolean(config.enableLeadFollowUp ?? true)
  }).catch(e => console.error('[maintenance]', e.message));
  const maintenanceTimer = setInterval(maintenance, Math.max(30, config.inactivityCheckSeconds) * 1000); maintenanceTimer.unref();
  const stop = async () => { clearInterval(maintenanceTimer); await store.flush(); server.close(() => process.exit(0)); }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
