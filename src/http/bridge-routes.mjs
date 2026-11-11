import { json, readBody, authorized, formatPhoneNumber, NOT_HANDLED } from './utils.mjs';
import { config } from '../config.mjs';
import { normalizePhone, isValidRealMobilePhone } from '../sessions.mjs';
import { isOwnerKey, OWNER_SELF_KEY } from '../core/identity.mjs';
import { getKnowledgeBaseContentSync, listKnowledgeBases, saveKnowledgeBase } from '../knowledge-bases.mjs';
import { sendText } from '../whatsapp.mjs';
import { broadcastBridgeEvent, bridgeSubscribers } from './bridge.mjs';

// Rotas /api/bridge/* (inclui o stream SSE de eventos).
export async function handleBridgeRoutes({ req, res, u, store, f, webhookAuthorize }) {
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
      'Access-Control-Allow-Origin': '*',
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
    const isBridgeAuth = config.allowUnauthenticatedDashboard || (webhookAuthorize ? await webhookAuthorize(req) : authorized(req));
    if (!isBridgeAuth) return json(res, 401, { error: 'unauthorized' });
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
    const isCopilotKey = isOwnerKey(rawPhone);
    const digits = isCopilotKey ? OWNER_SELF_KEY : normalizePhone(rawPhone.replace(/@.*$/, '').replace(/\D/g, ''));
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
  return NOT_HANDLED;
}
