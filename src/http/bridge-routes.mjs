import { createHash } from 'node:crypto';
import { json, readBody, authorized, formatPhoneNumber, NOT_HANDLED } from './utils.mjs';
import { config } from '../config.mjs';
import { normalizePhone, isValidRealMobilePhone } from '../sessions.mjs';
import { isOwnerKey, OWNER_SELF_KEY } from '../core/identity.mjs';
import { getKnowledgeBaseContentSync, listKnowledgeBases, saveKnowledgeBase } from '../knowledge-bases.mjs';
import { sendText } from '../whatsapp.mjs';
import { broadcastBridgeEvent, bridgeSubscribers } from './bridge.mjs';
import { TtlIdempotencyStore, idempotencyKey } from '../core/idempotency.mjs';
import { CampaignStore } from '../campaigns.mjs';
import { markBridgeConfigRead } from './bridge-config-status.mjs';
import { resumoJanelaDeAtendimento } from '../business-hours.mjs';
import { SectorProjection, SectorProjectionError } from '../sectors.mjs';

const bridgeActions = new TtlIdempotencyStore({ ttlMs: Number(process.env.BRIDGE_IDEMPOTENCY_TTL_MS || 10 * 60 * 1000) });
const safeError = error => error?.code || (error?.name === 'TimeoutError' ? 'provider_timeout' : 'request_failed');

async function isBridgeAuthorized(req, webhookAuthorize) {
  try {
    const result = typeof webhookAuthorize === 'function'
      ? await webhookAuthorize(req)
      : authorized(req);
    return typeof result === 'object' && result !== null ? result.ok === true : result === true;
  } catch {
    return false;
  }
}

function publicLiaConfig(active = {}) {
  const ai = active.ai || {};
  const automation = active.automation || {};
  const voice = active.voice || {};
  return {
    ai: {
      activeProvider: String(ai.activeProvider || ''),
      activeModel: String(ai.activeModel || ''),
      fallbackModels: Array.isArray(ai.fallbackModels) ? ai.fallbackModels.slice(0, 3).filter(item => typeof item === 'string') : [],
      agentMode: ai.agentMode === 'super_agente' ? 'super_agente' : 'assistente',
      enableToolCalling: ai.enableToolCalling === true
    },
    webSearch: { enabled: active.webSearch?.enabled !== false },
    automation: {
      enableMediaProcessing: automation.enableMediaProcessing !== false,
      enableProactiveFollowUp: automation.enableProactiveFollowUp !== false,
      businessHoursOnly: automation.businessHoursOnly !== false,
      autoHandoffOnHumanPresence: automation.autoHandoffOnHumanPresence !== false,
      maxDailyFollowUps: Number.isInteger(automation.maxDailyFollowUps) ? automation.maxDailyFollowUps : 30,
      followUpMinHours: Number.isFinite(Number(automation.followUpMinHours)) ? Number(automation.followUpMinHours) : 24,
      followUpMaxHours: Number.isFinite(Number(automation.followUpMaxHours)) ? Number(automation.followUpMaxHours) : 72,
      followUpTemplate: typeof automation.followUpTemplate === 'string' ? automation.followUpTemplate.slice(0, 2000) : ''
    },
    voice: {
      voiceName: String(voice.voiceName || 'Aoede'),
      tone: typeof voice.tone === 'string' ? voice.tone.slice(0, 500) : '',
      autoVoiceOnAudio: voice.autoVoiceOnAudio !== false
    },
    // Horário de atendimento: projeção somente-leitura do painel central.
    // Nunca expõe o texto do aviso ao cliente, que é conteúdo do atendimento da Lia.
    business: {
      hours: resumoJanelaDeAtendimento(active.business?.hoursConfig)
    }
  };
}

function handlePublishedConfigRead({ req, res, adminConfig }) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!adminConfig || adminConfig.persistence !== 'supabase') return json(res, 503, { ok: false, error: 'config_persistence_unavailable' });
  const revision = Number(adminConfig.revision) || 0;
  if (revision < 1 || !adminConfig.active) return json(res, 503, { ok: false, error: 'published_config_unavailable' });
  const settings = publicLiaConfig(adminConfig.active);
  const published = [...(adminConfig.history || [])].reverse().find(item => Number(item.revision) === revision && ['published', 'rollback'].includes(item.action));
  const body = {
    ok: true,
    contractVersion: 1,
    configSchemaVersion: Number(adminConfig.active.schemaVersion) || 1,
    revision,
    publishedAt: published?.at || null,
    settings
  };
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const etag = `"lia-config-v1-${revision}-${hash}"`;
  const headers = { etag, 'cache-control': 'private, no-cache', vary: 'Authorization' };
  const matches = String(req.headers['if-none-match'] || '').split(',').map(value => value.trim()).some(value => value === '*' || value === etag);
  markBridgeConfigRead(revision);
  if (matches) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function bridgeCorsHeaders(req) {
  return config.dashboardOrigin && req.headers.origin === config.dashboardOrigin
    ? { 'Access-Control-Allow-Origin': config.dashboardOrigin, Vary: 'Origin' }
    : {};
}

/**
 * Projeção de runtime dos setores do Chatwoot. Grava em memória/arquivo próprios
 * e jamais toca rascunho, validação, publicação ou revisão do painel administrativo.
 */
async function handleSectorProjection({ req, res, sectorProjection }) {
  if (!sectorProjection || typeof sectorProjection.replace !== 'function') {
    return json(res, 503, { ok: false, error: 'sector_projection_unavailable' });
  }
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, contractVersion: 1, sectors: sectorProjection.list(), ...sectorProjection.status() });
  }
  if (req.method !== 'PUT') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
  try {
    const status = await sectorProjection.replace(Array.isArray(body?.sectors) ? body.sectors : body);
    return json(res, 200, { ok: true, contractVersion: 1, ...status });
  } catch (error) {
    if (error instanceof SectorProjectionError) return json(res, error.status || 400, { ok: false, error: error.code });
    return json(res, 500, { ok: false, error: 'sector_projection_failed' });
  }
}

// Rotas /api/bridge/* (inclui o stream SSE de eventos).
export async function handleBridgeRoutes({ req, res, u, store, f, webhookAuthorize, campaignStore, adminConfig, sectorProjection = new SectorProjection() }) {
  if (u.pathname === '/api/bridge/v1/config') {
    if (!await isBridgeAuthorized(req, webhookAuthorize)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return handlePublishedConfigRead({ req, res, adminConfig });
  }
  if (u.pathname === '/api/bridge/v1/sectors') {
    if (!await isBridgeAuthorized(req, webhookAuthorize)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return handleSectorProjection({ req, res, sectorProjection });
  }
  if (u.pathname === '/api/bridge/campaigns' || u.pathname.startsWith('/api/bridge/campaigns/')) {
    if (!await isBridgeAuthorized(req, webhookAuthorize)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (!campaignStore) return json(res, 503, { ok: false, error: 'campaign_worker_unavailable' });
    try {
      if (req.method === 'GET' && u.pathname === '/api/bridge/campaigns') return json(res, 200, { ok: true, campaigns: await campaignStore.list() });
      if (req.method === 'POST' && u.pathname === '/api/bridge/campaigns') {
        const body = await readBody(req);
        return json(res, 201, { ok: true, campaign: await campaignStore.create({ ...body, idempotencyKey: req.headers['idempotency-key'] || body.idempotencyKey }) });
      }
      const match = u.pathname.match(/^\/api\/bridge\/campaigns\/([^/]+)(?:\/(pause|cancel|execute))?$/);
      if (!match) return json(res, 404, { ok: false, error: 'not_found' });
      const [, id, action] = match;
      if (req.method === 'GET' && !action) { const campaign = await campaignStore.get(id); return campaign ? json(res, 200, { ok: true, campaign }) : json(res, 404, { ok: false, error: 'campaign_not_found' }); }
      if (req.method === 'POST' && action === 'pause') return json(res, 200, { ok: true, campaign: await campaignStore.transition(id, 'paused') });
      if (req.method === 'POST' && action === 'cancel') return json(res, 200, { ok: true, campaign: await campaignStore.transition(id, 'cancelled') });
      if (req.method === 'POST' && action === 'execute') return json(res, 200, { ok: true, campaign: await campaignStore.execute(id) });
      return json(res, 405, { ok: false, error: 'method_not_allowed' });
    } catch (error) {
      const status = ['campaign_persistence_unavailable', 'campaign_worker_unavailable'].includes(error?.code) ? 503 : error?.code === 'invalid_campaign' ? 400 : 502;
      return json(res, status, { ok: false, error: error?.code || 'campaign_request_failed' });
    }
  }
  if (req.method === 'POST' && u.pathname === '/api/bridge/message') {
    const isBridgeAuth = await isBridgeAuthorized(req, webhookAuthorize);
    if (!isBridgeAuth) return json(res, 401, { ok: false, error: 'unauthorized' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
    const rawPhone = String(body.phone || body.senderIdentifier || '').trim();
    const text = String(body.text || body.content || '').trim();
    const pushName = String(body.pushName || body.senderName || '').trim();
    const origin = body.origin === 'simulation' ? 'simulation' : 'real';
    if (!rawPhone || !text) return json(res, 400, { ok: false, error: 'phone_and_text_required' });
    let digits = isOwnerKey(rawPhone)
      ? OWNER_SELF_KEY
      : rawPhone.replace(/@.*$/, '').replace(/\D/g, '');
    if (digits !== OWNER_SELF_KEY) {
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
      return json(res, 400, { ok: false, error: safeError(err) });
    }
  }
  if (req.method === 'POST' && u.pathname === '/api/bridge/mode') {
    const isBridgeAuth = await isBridgeAuthorized(req, webhookAuthorize);
    if (!isBridgeAuth) return json(res, 401, { ok: false, error: 'unauthorized' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
    const rawPhone = String(body.phone || '').trim();
    let digits = rawPhone.replace(/@.*$/, '').replace(/\D/g, '');
    if (digits.length < 8 && rawPhone) {
      let hash = 0;
      for (let i = 0; i < rawPhone.length; i++) hash = ((hash << 5) - hash + rawPhone.charCodeAt(i)) | 0;
      digits = ('99' + Math.abs(hash).toString().padStart(9, '0')).slice(0, 11);
    } else if (digits.length > 15) {
      digits = digits.slice(0, 15);
    }
    if (!digits || !['human', 'bot'].includes(body.mode)) return json(res, 400, { ok: false, error: 'invalid_mode_or_phone' });
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
      return json(res, 400, { ok: false, error: safeError(err) });
    }
  }
  if (req.method === 'POST' && u.pathname === '/api/bridge/send') {
    const isBridgeAuth = await isBridgeAuthorized(req, webhookAuthorize);
    if (!isBridgeAuth) return json(res, 401, { ok: false, error: 'unauthorized' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
    const rawPhone = String(body.phone || '').trim();
    const text = String(body.text || '').trim();
    const skipSession = Boolean(body.skipSession);
    if (!rawPhone || !text) return json(res, 400, { ok: false, error: 'phone_and_text_required' });
    const digits = rawPhone.replace(/@.*$/, '').replace(/\D/g, '');
    const targetJid = /@lid$/i.test(rawPhone) ? rawPhone : (digits || rawPhone);
    const actionKey = String(req.headers['idempotency-key'] || body.idempotencyKey || idempotencyKey('bridge-send', targetJid, text));
    const previous = bridgeActions.get(actionKey);
    if (previous) return json(res, previous.status, previous.body);
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
      const result = { status: sent ? 200 : 502, body: { ok: sent, sent, ...(sent ? {} : { error: 'provider_unavailable' }) } };
      bridgeActions.set(actionKey, result);
      return json(res, result.status, result.body);
    } catch (err) {
      return json(res, 400, { ok: false, error: safeError(err) });
    }
  }
  if (req.method === 'GET' && u.pathname === '/api/bridge/events') {
    const isBridgeAuth = await isBridgeAuthorized(req, webhookAuthorize);
    if (!isBridgeAuth) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (req.headers.origin && (!config.dashboardOrigin || req.headers.origin !== config.dashboardOrigin)) return json(res, 403, { ok: false, error: 'origin_not_allowed' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      ...bridgeCorsHeaders(req),
      'X-Accel-Buffering': 'no'
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
    const isBridgeAuth = await isBridgeAuthorized(req, webhookAuthorize);
    if (!isBridgeAuth) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (Object.keys(store.sessions).length === 0) {
      await store.refresh?.().catch(() => {});
    }
    const list = Object.entries(store.sessions)
      .filter(([key, s]) => {
        const rawPhone = s?.phone || key;
        return !key.startsWith('sim:') && (isOwnerKey(key) || isValidRealMobilePhone(rawPhone));
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
    const isBridgeAuth = await isBridgeAuthorized(req, webhookAuthorize);
    if (!isBridgeAuth) return json(res, 401, { ok: false, error: 'unauthorized' });
    const id = u.searchParams.get('id');
    if (id) {
      const kb = getKnowledgeBaseContentSync(id);
      if (!kb) return json(res, 404, { ok: false, error: 'not_found' });
      return json(res, 200, { ok: true, knowledgeBase: kb });
    }
    const bases = await listKnowledgeBases();
    return json(res, 200, { ok: true, knowledgeBases: bases });
  }
  if (req.method === 'POST' && u.pathname === '/api/bridge/knowledge-bases') {
    const isBridgeAuth = await isBridgeAuthorized(req, webhookAuthorize);
    if (!isBridgeAuth) return json(res, 401, { ok: false, error: 'unauthorized' });
    let body;
    try { body = await readBody(req, 2 * 1024 * 1024); } catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
    try {
      const saved = await saveKnowledgeBase({ id: body.id, title: body.title, content: body.content });
      return json(res, 200, { ok: true, knowledgeBase: saved });
    } catch (err) {
      return json(res, 400, { ok: false, error: safeError(err) });
    }
  }
  if (req.method === 'POST' && u.pathname === '/api/bridge/contact-context') {
    const isBridgeAuth = await isBridgeAuthorized(req, webhookAuthorize);
    if (!isBridgeAuth) return json(res, 401, { ok: false, error: 'unauthorized' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
    const rawPhone = String(body.phone || '').trim();
    const isCopilotKey = isOwnerKey(rawPhone);
    const digits = isCopilotKey ? OWNER_SELF_KEY : normalizePhone(rawPhone.replace(/@.*$/, '').replace(/\D/g, ''));
    if (!isCopilotKey && (!digits || digits.length < 8)) return json(res, 400, { ok: false, error: 'invalid_phone' });
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
      return json(res, 400, { ok: false, error: safeError(err) });
    }
  }
  return NOT_HANDLED;
}
