import { CustomSectorStore } from '../sectors/custom-sectors.mjs';
import { TenantStore } from '../tenants/store.mjs';
import { sendReputationSurvey } from '../flow/reputation.mjs';
import { runFollowUpCadence } from '../flow/followup-cadence.mjs';
import { json, readBody, formatPhoneNumber, formatActivityTime, NOT_HANDLED } from './utils.mjs';
import { config } from '../config.mjs';
import { validPhone } from '../dashboard.mjs';
import { sendText, deleteChatForSync, getProfilePictureUrl } from '../whatsapp.mjs';
import { getAIMetrics, getCircuitBreakers, resetMetrics, pingAI, OPENROUTER_FREE_MODELS, synthesizeVoice, getVoiceRuntimeStatus } from '../ai.mjs';
import { AI_AGENT_STRUCTURE } from '../knowledge.mjs';
import { listProviderModels } from '../ai/catalog.mjs';
import { MODEL_CAPABILITIES, decidirModeloPorContexto, detectarCapacidadesExigidas } from '../model-router.mjs';
import { ALL_TOOLS, isClientToolAllowed } from '../tools/index.mjs';
import { readVpsMetrics } from '../vps-monitor.mjs';
import { notifyReactivationToInternalChat, triggerSmartReactivationContinuation } from './reactivation-notice.mjs';
import { dedupeMessages } from '../supabase-runtime.mjs';
import { normalizePhone } from '../sessions.mjs';
import { isOwnerKey, OWNER_SELF_KEY } from '../core/identity.mjs';
import { isHumanHandoffActive, enterHumanHandoff, resumeHumanHandoff } from '../flow/human-handoff-state.mjs';
import { listKnowledgeBases, saveKnowledgeBase } from '../knowledge-bases.mjs';
import { resolveGoogleAccessToken } from '../tools/google_auth.mjs';

function sameInstancePhone(a, b) {
  const na = normalizePhone(String(a || '').replace(/@.*$/, '').replace(/\D/g, ''));
  const nb = normalizePhone(String(b || '').replace(/@.*$/, '').replace(/\D/g, ''));
  return Boolean(na && nb && na === nb);
}

// Rotas de estado/simulação/envio do painel (executadas antes das rotas /api/bridge/*).
async function persistAdminPatch(adminConfig, patch) {
  if (!adminConfig) return;
  if (typeof adminConfig.updateDraft === 'function' && typeof adminConfig.publish === 'function') {
    const upd = await adminConfig.updateDraft(patch, 'dashboard');
    if (upd?.ok === false) throw new Error((upd.errors || ['Falha ao atualizar rascunho']).join('; '));
    const pub = await adminConfig.publish('dashboard');
    if (pub?.ok === false && !pub.noChanges) throw new Error((pub.errors || ['Falha ao publicar no banco']).join('; '));
    return;
  }
  if (adminConfig.active) Object.assign(adminConfig.active, patch);
}

const defaultTenantStore = new TenantStore().load();
const defaultSectorStore = new CustomSectorStore().load();
const VALID_FUNNEL_STAGES = new Set(['novo', 'em_atendimento', 'agendado', 'transferido', 'fechado']);

function resolveFunnelStage(s, history) {
  if (VALID_FUNNEL_STAGES.has(s?.funnelStage)) return s.funnelStage;
  if (isHumanHandoffActive(s)) return 'transferido';
  if (s?.finished || s?.status === 'finished') return 'fechado';
  if (s?.scheduled || s?.meetingScheduled) return 'agendado';
  if (Array.isArray(history) && history.length > 0) return 'em_atendimento';
  return 'novo';
}

export async function handleDashboardRoutes({ req, res, u, store, f, deliverReactivationReply = null, getActiveInstancePhone = null, notifyCopilot = null }) {
  if (req.method === 'GET' && u.pathname === '/api/dashboard/avatar') {
    const rawPhone = String(u.searchParams.get('phone') || '').trim();
    if (!rawPhone || isOwnerKey(rawPhone) || rawPhone.startsWith('sim:') || rawPhone.length > 64) {
      res.writeHead(204, { 'cache-control': 'private, max-age=300' });
      return res.end();
    }
    try {
      const picUrl = await getProfilePictureUrl(rawPhone);
      if (!picUrl) {
        res.writeHead(204, { 'cache-control': 'private, max-age=1800' });
        return res.end();
      }
      const parsed = new URL(picUrl);
      const allowedHost = parsed.protocol === 'https:' && /(?:^|\.)(?:whatsapp\.net|fbcdn\.net)$/i.test(parsed.hostname);
      if (!allowedHost) {
        res.writeHead(204, { 'cache-control': 'private, max-age=1800' });
        return res.end();
      }
      const imgRes = await fetch(parsed.toString(), { signal: AbortSignal.timeout(8000) });
      if (!imgRes.ok) {
        res.writeHead(204, { 'cache-control': 'private, max-age=600' });
        return res.end();
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (!buf.length || buf.length > 2 * 1024 * 1024) {
        res.writeHead(204, { 'cache-control': 'private, max-age=600' });
        return res.end();
      }
      const ctype = String(imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      res.writeHead(200, {
        'content-type': ctype.startsWith('image/') ? ctype : 'image/jpeg',
        'cache-control': 'private, max-age=3600',
        'content-length': String(buf.length)
      });
      return res.end(buf);
    } catch {
      res.writeHead(204, { 'cache-control': 'private, max-age=600' });
      return res.end();
    }
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/state') {
    await store.refresh?.();
    const mode = u.searchParams.get('mode') || 'all';
    const includeOtherInstances = u.searchParams.get('includeOtherInstances') === '1';
    const activeInstancePhone = typeof getActiveInstancePhone === 'function'
      ? String(getActiveInstancePhone() || '').replace(/@.*$/, '').replace(/\D/g, '')
      : '';
    const allEntries = Object.entries(store.sessions || {});
    let realCount = 0;
    let simCount = 0;
    let handoffCount = 0;
    let otherInstancesCount = 0;
    for (const [k, s] of allEntries) {
      const isSim = k.startsWith('sim:') || s?.origin === 'simulation';
      const rawPhone = s?.phone || k.replace(/^sim:/, '');
      const isCopilotSelf = isOwnerKey(rawPhone) || isOwnerKey(k) || /^[a-z0-9_]+_self$/i.test(rawPhone);
      const belongsToOtherInstance = Boolean(
        activeInstancePhone
        && !isSim
        && !isCopilotSelf
        && !sameInstancePhone(s?.instancePhone, activeInstancePhone)
      );
      if (belongsToOtherInstance) {
        otherInstancesCount++;
        if (!includeOtherInstances) continue;
      }
      if (isSim) simCount++;
      else realCount++;
      if (isHumanHandoffActive(s)) handoffCount++;
    }

    const sessions = allEntries
      .filter(([key, s]) => {
        const isSim = key.startsWith('sim:') || s?.origin === 'simulation';
        if (mode !== 'all' && (mode === 'simulation' ? !isSim : isSim)) return false;
        if (activeInstancePhone && !includeOtherInstances && !isSim) {
          const rawPhone = s?.phone || key.replace(/^sim:/, '');
          const isCopilotSelf = isOwnerKey(rawPhone) || isOwnerKey(key) || /^[a-z0-9_]+_self$/i.test(rawPhone);
          if (!isCopilotSelf && !sameInstancePhone(s?.instancePhone, activeInstancePhone)) {
            return false;
          }
        }
        return true;
      })
      .map(([key, s]) => {
        const rawPhone = s.phone || key.replace(/^sim:/, '');
        const isCopilotSelf = isOwnerKey(rawPhone) || isOwnerKey(key) || /^[a-z0-9_]+_self$/i.test(rawPhone);
        const phoneFormatted = isCopilotSelf ? 'Canal Interno Copiloto' : formatPhoneNumber(rawPhone);
        const clientName = (s.clientName || s.contactName || s.pushName || (isCopilotSelf ? 'Copiloto Interno (Gestor)' : '')).trim();
        const displayName = clientName || phoneFormatted;

        const history = dedupeMessages(Array.isArray(s.history) ? s.history : []);
        const lastMsg = history.length > 0 ? history[history.length - 1] : null;

        let preview = 'Sem mensagens ainda';
        if (lastMsg) {
          const prefix = lastMsg.role === 'assistant' ? 'Lia: ' : '';
          const cleanContent = String(lastMsg.content || '').replace(/\s+/g, ' ').trim();
          preview = prefix + (cleanContent.length > 80 ? cleanContent.slice(0, 80) + '…' : cleanContent);
        }

        const tsCandidates = [
          lastMsg?.createdAt,
          s.lastUserAt,
          s.lastBotAt,
          s.updatedAt,
          s.createdAt
        ].filter(Boolean);
        let bestTs = 0;
        let lastActivityIso = '';
        for (const candidate of tsCandidates) {
          const parsed = Date.parse(candidate);
          if (Number.isFinite(parsed) && parsed >= bestTs) {
            bestTs = parsed;
            lastActivityIso = new Date(parsed).toISOString();
          }
        }
        if (!lastActivityIso) {
          lastActivityIso = new Date(0).toISOString();
        }
        const lastActivityTime = bestTs;
        const time = bestTs > 0 ? formatActivityTime(lastActivityIso) : '';

        return {
          ...s,
          phone: key.startsWith('sim:') ? key : rawPhone,
          rawPhone,
          phoneFormatted,
          name: displayName,
          displayName,
          clientName,
          origin: s.origin || (key.startsWith('sim:') ? 'simulation' : 'real'),
          human: isHumanHandoffActive(s),
          isInternal: Boolean(isCopilotSelf || (activeInstancePhone && sameInstancePhone(rawPhone, activeInstancePhone))),
          funnelStage: resolveFunnelStage(s, history),
          updatedAt: s.updatedAt,
          lastActivityIso,
          lastActivityTime,
          time,
          preview,
          history
        };
      })
      .sort((a, b) => (b.lastActivityTime - a.lastActivityTime) || String(a.phone || '').localeCompare(String(b.phone || '')));

    return json(res, 200, {
      mode,
      activeInstancePhone: activeInstancePhone || null,
      includeOtherInstances,
      otherInstancesCount,
      persistence: store.persistence || 'fallback',
      persistenceError: store.remoteError || null,
      counts: {
        total: allEntries.length,
        real: realCount,
        simulation: simCount,
        handoff: handoffCount
      },
      sessions
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/simulate') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    if (!validPhone(body.phone) || !body.text) return json(res, 400, { error: 'phone_and_text_required' });
    const safeReplyTo = body.replyTo && typeof body.replyTo === 'object'
      ? {
          sender: String(body.replyTo.sender || 'Mensagem').slice(0, 60),
          content: String(body.replyTo.content || '').slice(0, 280),
          index: Number.isFinite(Number(body.replyTo.index)) ? Number(body.replyTo.index) : null
        }
      : null;
    const safeMediaType = ['audio', 'image', 'document', 'text'].includes(body.mediaType) ? body.mediaType : null;
    const simContextText = safeReplyTo?.content
      ? `O contato está respondendo/citando uma mensagem anterior.\nConteúdo citado (${safeReplyTo.sender}): ${safeReplyTo.content}`
      : '';
    const answer = await store.enqueue(body.phone, async () => {
      const reply = await f.process({
        phone: body.phone,
        text: body.text,
        origin: 'simulation',
        contextText: simContextText,
        mediaType: safeMediaType && safeMediaType !== 'text' ? safeMediaType : null
      });
      const simSession = store.get(body.phone, 'simulation');
      if (simSession && Array.isArray(simSession.history) && (safeReplyTo || safeMediaType)) {
        const lastUserIdx = [...simSession.history].map((m, idx) => m.role === 'user' ? idx : -1).filter(idx => idx >= 0).pop();
        if (lastUserIdx !== undefined && simSession.history[lastUserIdx]) {
          if (safeReplyTo) simSession.history[lastUserIdx].replyTo = safeReplyTo;
          if (safeMediaType && safeMediaType !== 'text') simSession.history[lastUserIdx].mediaType = safeMediaType;
          if (body.fileName) simSession.history[lastUserIdx].fileName = String(body.fileName).slice(0, 120);
          store.markDirty();
        }
      }
      return reply;
    });
    return json(res, 200, { answer });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/send') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const rawPhone = String(body.phone || '').trim();
    const isInternalChat = isOwnerKey(rawPhone) || /^[a-z0-9_]+_self$/i.test(rawPhone);
    if ((!isInternalChat && !validPhone(rawPhone)) || typeof body.text !== 'string' || !body.text.trim()) {
      return json(res, 400, { error: 'phone_and_text_required' });
    }
    const text = body.text.trim();
    if (isInternalChat) {
      if (rawPhone !== OWNER_SELF_KEY && store.sessions?.[rawPhone]) {
        const legacySess = store.sessions[rawPhone];
        const targetSess = store.get(OWNER_SELF_KEY);
        if (Array.isArray(legacySess?.history) && legacySess.history.length && (!Array.isArray(targetSess.history) || !targetSess.history.length)) {
          targetSess.history = [...legacySess.history];
        }
        delete store.sessions[rawPhone];
        store.markDirty();
      }
      const internalContextText = body.replyTo?.content
        ? `O usuário está respondendo/citando uma mensagem anterior.\nConteúdo citado (${String(body.replyTo.sender || 'Mensagem').slice(0, 60)}): ${String(body.replyTo.content).slice(0, 280)}`
        : '';
      const answer = await store.enqueue(OWNER_SELF_KEY, () => f.process({
        phone: OWNER_SELF_KEY,
        text,
        origin: 'dashboard',
        contextText: internalContextText
      }));
      await store.flush?.().catch(() => {});
      if (answer && typeof notifyCopilot === 'function') {
        void Promise.resolve(notifyCopilot(answer)).catch(() => {});
      }
      return json(res, 200, { ok: true, sent: true, internal: true, selectedPhone: OWNER_SELF_KEY, answer: answer || null });
    }
    const phone = rawPhone;
    const safeReplyTo = body.replyTo && typeof body.replyTo === 'object'
      ? {
          sender: String(body.replyTo.sender || 'Contato').slice(0, 60),
          content: String(body.replyTo.content || '').slice(0, 280),
          index: Number.isFinite(Number(body.replyTo.index)) ? Number(body.replyTo.index) : null
        }
      : null;
    let sent = false;
    let sendError = null;
    const outboundText = safeReplyTo
      ? `> _"${safeReplyTo.content.replace(/\s+/g, ' ').slice(0, 100)}"_\n\n${text}`
      : text;
    const existingSess = store.get(phone);
    const sendTarget = (existingSess?.jid && /@lid$/i.test(existingSess.jid) && !/^\d{10,13}$/.test(String(phone).replace(/\D/g, '')))
      ? existingSess.jid
      : phone;
    try {
      await sendText(sendTarget, outboundText);
      sent = true;
    } catch (err) {
      sendError = err?.message || 'send_failed';
      console.error('[dashboard/send] falha ao enviar WhatsApp:', sendError);
    }
    if (!sent) {
      // Entrega não confirmada: não cria sessão, não registra histórico e não
      // muda o modo da conversa.
      return json(res, 502, { ok: false, sent: false, error: sendError, selectedPhone: phone });
    }
    const session = store.ensure(phone);
    enterHumanHandoff(session, {
      source: 'dashboard',
      at: new Date().toISOString(),
      reason: 'resposta enviada pelo painel'
    });
    session.handoffReminderAt = null;
    if (!Array.isArray(session.history)) session.history = [];
    session.history.push({
      role: 'assistant',
      content: text,
      createdAt: new Date().toISOString(),
      ...(safeReplyTo ? { replyTo: safeReplyTo } : {})
    });
    session.lastBotAt = new Date().toISOString();
    const activeInst = typeof getActiveInstancePhone === 'function'
      ? String(getActiveInstancePhone() || '').replace(/@.*$/, '').replace(/\D/g, '')
      : '';
    if (activeInst && !isOwnerKey(body.phone)) {
      session.instancePhone = activeInst;
    }
    session.updatedAt = new Date().toISOString();
    store.markDirty();
    await store.flush?.().catch(() => {});
    return json(res, 200, { ok: true, sent: true, selectedPhone: phone });
  }
  return NOT_HANDLED;
}

// Modo/limpeza/configuração do painel (executadas depois das rotas /api/bridge/*).
export async function handleDashboardSettingsRoutes({ req, res, u, store, runtimeAI, adminConfig = null, tenantStore = null, customSectorStore = null, f = null, deliverReactivationReply = null }) {
  const activeTenantStore = tenantStore || defaultTenantStore;
  const activeSectorStore = customSectorStore || defaultSectorStore;
  if (req.method === 'POST' && u.pathname === '/api/dashboard/mode') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    if (!validPhone(body.phone) || !['human', 'bot'].includes(body.mode)) return json(res, 400, { error: 'invalid_mode_or_phone' });
    const session = store.get(body.phone);
    const wasHuman = isHumanHandoffActive(session);
    const isHuman = body.mode === 'human';
    if (isHuman) {
      enterHumanHandoff(session, {
        source: 'dashboard',
        at: new Date().toISOString(),
        reason: 'modo humano ativado manualmente pelo painel'
      });
    } else {
      resumeHumanHandoff(session, {
        source: null,
        clearHandoffAt: true,
        clearNotifications: true,
        clearReminderFlags: true
      });
      session.inactivityClosed = false;
      if (wasHuman) {
        if (body.autoContinue !== false && deliverReactivationReply && f) {
          void triggerSmartReactivationContinuation({ store, session, phone: body.phone, flow: f, sendReply: deliverReactivationReply });
        } else {
          notifyReactivationToInternalChat({ store, session, phone: body.phone });
        }
      }
    }
    session.handoffReminderAt = null;
    const activeInst = typeof getActiveInstancePhone === 'function'
      ? String(getActiveInstancePhone() || '').replace(/@.*$/, '').replace(/\D/g, '')
      : '';
    if (activeInst && !isOwnerKey(phone)) {
      session.instancePhone = activeInst;
    }
    session.updatedAt = new Date().toISOString();
    store.markDirty();
    await store.flush?.().catch(() => {});
    return json(res, 200, { ok: true, human: isHumanHandoffActive(session) });
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/sectors-custom') {
    return json(res, 200, { ok: true, sectors: activeSectorStore.list() });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/sectors-custom') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    if (!body?.id && !body?.name) return json(res, 400, { error: 'missing_id_or_name' });
    try {
      const sector = await activeSectorStore.upsert(body);
      return json(res, 200, { ok: true, sector });
    } catch {
      return json(res, 400, { error: 'invalid_sector' });
    }
  }
  if (req.method === 'DELETE' && u.pathname === '/api/dashboard/sectors-custom') {
    const id = u.searchParams.get('id') || '';
    const removed = await activeSectorStore.remove(id);
    if (!removed) return json(res, 400, { error: 'sector_not_found' });
    return json(res, 200, { ok: true, removed: id });
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/tenants') {
    return json(res, 200, { ok: true, tenants: activeTenantStore.list() });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/tenants') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    if (!body?.id && !body?.name) return json(res, 400, { error: 'missing_id_or_name' });
    const tenant = await activeTenantStore.upsert(body);
    return json(res, 200, { ok: true, tenant });
  }
  if (req.method === 'DELETE' && u.pathname === '/api/dashboard/tenants') {
    const id = u.searchParams.get('id') || '';
    const removed = await activeTenantStore.remove(id);
    if (!removed) return json(res, 400, { error: 'cannot_remove_tenant' });
    return json(res, 200, { ok: true, removed: id });
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/missed-call') {
    const missedCall = adminConfig?.active?.missedCall || { enabled: false, delaySeconds: 60, message: '' };
    return json(res, 200, { ok: true, missedCall });
  }
  if (req.method === 'PUT' && u.pathname === '/api/dashboard/missed-call') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const next = {
      enabled: Boolean(body.enabled),
      delaySeconds: Math.min(3600, Math.max(5, Number(body.delaySeconds || 60))),
      message: String(body.message || '').trim().slice(0, 1000) || 'Oi! Vi que você tentou ligar agora há pouco e não conseguimos atender. Como posso te ajudar por aqui?',
    };
    await persistAdminPatch(adminConfig, { missedCall: next });
    return json(res, 200, { ok: true, missedCall: next });
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/reputation') {
    const reputation = adminConfig?.active?.reputation || { enabled: false, googleReviewUrl: '', minPositiveRating: 4, surveyMessage: '' };
    return json(res, 200, { ok: true, reputation });
  }
  if (req.method === 'PUT' && u.pathname === '/api/dashboard/reputation') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const next = {
      enabled: Boolean(body.enabled),
      googleReviewUrl: String(body.googleReviewUrl || '').trim().slice(0, 500),
      minPositiveRating: Math.min(5, Math.max(1, Number(body.minPositiveRating || 4))),
      surveyMessage: String(body.surveyMessage || '').trim().slice(0, 1000) || 'Obrigado pelo contato! De 1 a 5, como você avalia nosso atendimento hoje?',
    };
    await persistAdminPatch(adminConfig, { reputation: next });
    return json(res, 200, { ok: true, reputation: next });
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/cadence') {
    const cadence = adminConfig?.active?.automation?.followUpCadence || [];
    return json(res, 200, { ok: true, cadence });
  }
  if (req.method === 'PUT' && u.pathname === '/api/dashboard/cadence') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const steps = Array.isArray(body.cadence) ? body.cadence : [];
    const cleaned = steps.map((s, idx) => ({
      id: String(s.id || `step_${idx + 1}`),
      delayMinutes: Math.max(1, Number(s.delayMinutes || 60)),
      stageFilter: String(s.stageFilter || 'all'),
      message: String(s.message || '').trim().slice(0, 2000),
    })).filter((s) => s.message);
    await persistAdminPatch(adminConfig, { automation: { ...(adminConfig?.active?.automation || {}), followUpCadence: cleaned } });
    return json(res, 200, { ok: true, cadence: cleaned });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/cadence/run') {
    const cadence = adminConfig?.active?.automation?.followUpCadence || [];
    const maxDaily = Number(adminConfig?.active?.automation?.maxDailyFollowUps ?? 30);
    const result = await runFollowUpCadence({
      sessions: store.sessions || {},
      cadence,
      maxDaily,
      sendText,
      onSent: () => store.markDirty(),
    });
    await store.flush?.().catch(() => {});
    return json(res, 200, { ok: true, ...result });
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/knowledge-bases') {
    const bases = (await listKnowledgeBases()).filter(kb => !kb.copilotOnly);
    return json(res, 200, { ok: true, knowledgeBases: bases });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/knowledge-bases') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const rawId = String(body?.id || '').trim();
    const content = String(body?.content || '');
    if (!rawId || !content.trim()) return json(res, 400, { error: 'id_and_content_required' });
    const safeId = rawId.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'base_suporte';
    await saveKnowledgeBase(safeId, content);
    const bases = (await listKnowledgeBases()).filter(kb => !kb.copilotOnly);
    return json(res, 200, { ok: true, id: safeId, knowledgeBases: bases });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/crm-contact') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const rawPhone = normalizePhone(String(body.phone || '')) || String(body.phone || '').trim();
    if (!validPhone(rawPhone)) return json(res, 400, { error: 'invalid_phone' });
    let session = store.get(rawPhone);
    if (!session) {
      if (body.create !== true) return json(res, 404, { error: 'session_not_found' });
      session = store.ensure(rawPhone);
      session.origin = 'real';
      session.createdAt ||= new Date().toISOString();
      const activeInst = typeof getActiveInstancePhone === 'function' ? getActiveInstancePhone() : '';
      if (activeInst && !session.instancePhone) session.instancePhone = activeInst;
    }
    if (body.clientName !== undefined) session.clientName = String(body.clientName || '').trim().slice(0, 120);
    if (body.email !== undefined) session.email = String(body.email || '').trim().slice(0, 160);
    if (body.dealValue !== undefined) {
      const val = Number(String(body.dealValue).replace(',', '.'));
      session.dealValue = Number.isFinite(val) && val >= 0 ? Math.round(val * 100) / 100 : 0;
    }
    if (body.notes !== undefined) session.notes = String(body.notes || '').trim().slice(0, 4000);
    if (body.aiContext !== undefined) session.aiContext = String(body.aiContext || '').trim().slice(0, 2000);
    if (body.notALead !== undefined) session.notALead = Boolean(body.notALead);
    if (body.knowledgeBaseIds !== undefined || body.knowledgeBaseId !== undefined) {
      const rawList = Array.isArray(body.knowledgeBaseIds)
        ? body.knowledgeBaseIds
        : (body.knowledgeBaseId ? [body.knowledgeBaseId] : []);
      const cleanIds = [...new Set(rawList.map(x => String(x || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 10);
      session.knowledgeBaseIds = cleanIds;
      session.knowledgeBaseId = cleanIds[0] || null;
      if (cleanIds.length > 0) session.supportModeEnabled = true;
    }
    if (body.supportModeEnabled !== undefined) {
      session.supportModeEnabled = Boolean(body.supportModeEnabled) || Boolean(session.knowledgeBaseIds?.length);
    }
    if (body.sectorId !== undefined) session.sectorId = String(body.sectorId || '').trim().slice(0, 60);
    if (body.tags !== undefined) {
      session.tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(','))
        .map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20);
    }
    if (body.funnelStage !== undefined && VALID_FUNNEL_STAGES.has(String(body.funnelStage).trim())) {
      session.funnelStage = String(body.funnelStage).trim();
    }
    session.updatedAt = new Date().toISOString();
    store.markDirty();
    await store.flush?.().catch(() => {});
    return json(res, 200, { ok: true, phone: rawPhone, crm: { clientName: session.clientName, email: session.email, dealValue: session.dealValue || 0, notes: session.notes || '', aiContext: session.aiContext || '', notALead: Boolean(session.notALead), knowledgeBaseIds: Array.isArray(session.knowledgeBaseIds) ? session.knowledgeBaseIds : (session.knowledgeBaseId ? [session.knowledgeBaseId] : []), knowledgeBaseId: session.knowledgeBaseId || null, supportModeEnabled: Boolean(session.supportModeEnabled), sectorId: session.sectorId || '', tags: session.tags || [], funnelStage: session.funnelStage || 'novo' } });
  }
  if (req.method === 'DELETE' && u.pathname === '/api/dashboard/crm-contact') {
    let body = {};
    try { body = await readBody(req); } catch {}
    const rawPhone = String(u.searchParams.get('phone') || body?.phone || '').trim();
    const targetPhone = normalizePhone(rawPhone) || rawPhone;
    if (!validPhone(targetPhone)) return json(res, 400, { error: 'invalid_phone' });
    const archived = await store.archive(targetPhone, 'contato_excluido_crm');
    if (store.sessions?.[targetPhone]) {
      delete store.sessions[targetPhone];
      store.markDirty();
    }
    if (!archived && !store.sessions) return json(res, 404, { ok: false, error: 'contact_not_found' });
    await store.flush?.().catch(() => {});
    return json(res, 200, { ok: true, phone: targetPhone });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/contacts/import') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const list = Array.isArray(body?.contacts) ? body.contacts.slice(0, 500) : [];
    if (!list.length) return json(res, 400, { error: 'empty_contacts_list' });
    const activeInst = typeof getActiveInstancePhone === 'function' ? getActiveInstancePhone() : '';
    let imported = 0;
    let skipped = 0;
    const nowIso = new Date().toISOString();
    for (const item of list) {
      const normalized = normalizePhone(String(item?.phone || ''));
      if (!normalized || !validPhone(normalized)) { skipped++; continue; }
      const s = store.ensure(normalized);
      s.origin ||= 'real';
      s.createdAt ||= nowIso;
      if (activeInst && !s.instancePhone) s.instancePhone = activeInst;
      if (item.clientName) s.clientName = String(item.clientName).trim().slice(0, 120);
      if (item.email) s.email = String(item.email).trim().slice(0, 160);
      if (item.notes) s.notes = String(item.notes).trim().slice(0, 4000);
      if (item.aiContext) s.aiContext = String(item.aiContext).trim().slice(0, 2000);
      if (item.sectorId) s.sectorId = String(item.sectorId).trim().slice(0, 60);
      if (Array.isArray(item.tags) && item.tags.length) {
        s.tags = item.tags.map(t => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20);
      }
      s.funnelStage ||= 'novo';
      s.updatedAt = nowIso;
      imported++;
    }
    store.markDirty();
    await store.flush?.().catch(() => {});
    return json(res, 200, { ok: true, imported, skipped });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/contacts/import-google') {
    try {
      const token = await resolveGoogleAccessToken();
      if (!token) {
        return json(res, 400, { ok: false, error: 'google_contacts_not_authorized', message: 'Conta Google não conectada. Conecte em Integrações ou importe o arquivo CSV exportado do Google Contatos.' });
      }
      const resPeople = await fetch('https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,biographies,organizations&pageSize=500', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!resPeople.ok) {
        return json(res, 400, { ok: false, error: 'google_contacts_scope_missing', message: 'Autorize a permissão "Google Contatos" em Integrações → Google Workspace ou importe via arquivo CSV do Google Contatos.' });
      }
      const data = await resPeople.json();
      const connections = Array.isArray(data?.connections) ? data.connections : [];
      const activeInst = typeof getActiveInstancePhone === 'function' ? getActiveInstancePhone() : '';
      let imported = 0;
      let skipped = 0;
      const nowIso = new Date().toISOString();
      for (const person of connections) {
        const rawPhone = person?.phoneNumbers?.[0]?.canonicalForm || person?.phoneNumbers?.[0]?.value || '';
        const normalized = normalizePhone(String(rawPhone));
        if (!normalized || !validPhone(normalized)) { skipped++; continue; }
        const s = store.ensure(normalized);
        s.origin ||= 'real';
        s.createdAt ||= nowIso;
        if (activeInst && !s.instancePhone) s.instancePhone = activeInst;
        const name = String(person?.names?.[0]?.displayName || '').trim();
        const email = String(person?.emailAddresses?.[0]?.value || '').trim();
        const org = String(person?.organizations?.[0]?.name || '').trim();
        const bio = String(person?.biographies?.[0]?.value || '').trim();
        if (name && !s.clientName) s.clientName = name.slice(0, 120);
        if (email && !s.email) s.email = email.slice(0, 160);
        if ((org || bio) && !s.notes) s.notes = [org, bio].filter(Boolean).join(' · ').slice(0, 4000);
        s.funnelStage ||= 'novo';
        s.updatedAt = nowIso;
        imported++;
      }
      store.markDirty();
      await store.flush?.().catch(() => {});
      return json(res, 200, { ok: true, imported, skipped, totalFound: connections.length });
    } catch (err) {
      return json(res, 500, { ok: false, error: 'google_contacts_import_failed', message: err?.message || 'Falha ao importar contatos do Google.' });
    }
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/canned-responses') {
    const items = Array.isArray(adminConfig?.active?.cannedResponses) ? adminConfig.active.cannedResponses : [];
    return json(res, 200, { ok: true, items });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/canned-responses') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const shortcut = String(body.shortcut || '').trim().replace(/^\/+/, '').toLowerCase().slice(0, 40);
    const content = String(body.content || '').trim().slice(0, 2000);
    if (!shortcut || !content) return json(res, 400, { error: 'missing_shortcut_or_content' });
    const current = Array.isArray(adminConfig?.active?.cannedResponses) ? [...adminConfig.active.cannedResponses] : [];
    const idx = current.findIndex((x) => x.shortcut === shortcut);
    const item = { id: idx >= 0 ? current[idx].id : `macro_${shortcut}`, shortcut, title: String(body.title || shortcut).trim().slice(0, 80), content };
    if (idx >= 0) current[idx] = item; else current.push(item);
    await persistAdminPatch(adminConfig, { cannedResponses: current });
    return json(res, 200, { ok: true, item, items: current });
  }
  if (req.method === 'DELETE' && u.pathname === '/api/dashboard/canned-responses') {
    const shortcut = String(u.searchParams.get('shortcut') || '').trim().replace(/^\/+/, '').toLowerCase();
    const current = Array.isArray(adminConfig?.active?.cannedResponses) ? adminConfig.active.cannedResponses : [];
    const next = current.filter((x) => x.shortcut !== shortcut);
    await persistAdminPatch(adminConfig, { cannedResponses: next });
    return json(res, 200, { ok: true, items: next });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/funnel-stage') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const stage = String(body.stage || '').trim();
    if (!validPhone(body.phone)) return json(res, 400, { error: 'invalid_phone' });
    if (!VALID_FUNNEL_STAGES.has(stage)) return json(res, 400, { error: 'invalid_stage' });
    const session = store.get(body.phone);
    if (!session) return json(res, 404, { error: 'session_not_found' });
    session.funnelStage = stage;
    if (stage === 'fechado' && adminConfig?.active?.reputation?.enabled) {
      void sendReputationSurvey({ session, phone: body.phone, sendText, reputationConfig: adminConfig.active.reputation }).catch(() => {});
    }
    session.updatedAt = new Date().toISOString();
    store.markDirty();
    await store.flush?.().catch(() => {});
    return json(res, 200, { ok: true, phone: body.phone, stage });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/finish') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    if (!validPhone(body.phone)) return json(res, 400, { error: 'invalid_phone' });
    const session = store.get(body.phone);
    if (!session || !isHumanHandoffActive(session)) {
      // Jǭ em modo bot (ou sessǜo inexistente): nada a concluir, aǜo duplicada Ǹ no-op.
      return json(res, 200, { ok: true, alreadyBot: true });
    }
    // Devolve para o bot usando a mesma limpeza da rota /mode (handoffAt, notificações e lembretes),
    // sem notificar reativação: aqui o atendimento está sendo concluído, não retomado.
    resumeHumanHandoff(session, {
      source: null,
      clearHandoffAt: true,
      clearHandoffReason: true,
      clearReminderAt: true,
      clearNotifications: true,
      clearReminderFlags: true
    });
    session.inactivityClosed = false;
    const finishedAt = new Date().toISOString();
    session.finishedAt = finishedAt;
    session.finishReason = 'atendimento finalizado pelo painel';
    // Limpa pending de reativação apontando para este contato e rascunho pendente da sessão, se houver.
    const selfSession = store.get?.(OWNER_SELF_KEY);
    if (selfSession?.pendingReactivation && String(selfSession.pendingReactivation.phone) === String(body.phone)) {
      selfSession.pendingReactivation = null;
      selfSession.updatedAt = finishedAt;
      store.markDirty();
    }
    if (session.pendingDraft !== undefined) session.pendingDraft = null;
    if (!Array.isArray(session.history)) session.history = [];
    const note = 'Atendimento finalizado — Lia retomou o atendimento';
    session.history.push({ role: 'assistant', content: note, systemNote: true, createdAt: finishedAt });
    session.updatedAt = finishedAt;
    store.markDirty();
    await store.flush?.().catch(() => {});
    return json(res, 200, { ok: true, human: false, alreadyBot: false, finishedAt });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/clear') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    if (!validPhone(body.phone)) return json(res, 400, { error: 'invalid_phone' });
    const simulation = body.mode === 'simulation' || body.simulation === true;
    if (!simulation && !(body.confirm === true && typeof body.reason === 'string' && body.reason.trim())) return json(res, 400, { error: 'confirm_and_reason_required' });
    if (simulation) {
      const archived = await store.archive(`sim:${body.phone}`, body.reason || 'simulação encerrada');
      if (!archived) return json(res, 404, { ok: false, error: 'conversation_not_found' });
    } else {
      const syncCfg = adminConfig?.active?.sync || {};
      if (syncCfg.whatsappSyncEnabled && typeof store.softDeleteConversation === 'function') {
        let removed = false;
        try {
          removed = await store.softDeleteConversation({
            key: body.phone,
            source: 'dashboard',
            archive: syncCfg.archiveDeletedMessages !== false
          });
        } catch {
          removed = false;
        }
        // Só confirma a exclusão quando o store remoto confirmou de fato.
        if (!removed) return json(res, 502, { ok: false, error: 'delete_failed' });
        await deleteChatForSync({ jid: body.phone }).catch(() => {});
      } else {
        const archived = await store.archive(body.phone, body.reason);
        if (!archived) return json(res, 404, { ok: false, error: 'conversation_not_found' });
      }
    }
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/config') return json(res, 200, { provider: runtimeAI().provider, model: runtimeAI().model, instance: config.evolutionInstance, faqUrl: Boolean(config.faqUrl), faqCacheSeconds: config.faqCacheSeconds, fallbackModels: runtimeAI().fallbackModels, providers: getCircuitBreakers(), persistence: store.persistence || 'fallback', persistenceError: store.remoteError || null });
  return NOT_HANDLED;
}

// Modelos/estrutura/métricas/ping de IA do painel (executadas após as rotas administrativas).
export async function handleDashboardRuntimeRoutes({ req, res, u, store, runtimeAI, readinessCheck, adminConfig, operationsStore, aiBudgetGate }) {
  if (req.method === 'GET' && u.pathname === '/api/dashboard/health-summary') {
    const readiness = await readinessCheck();
    const metrics = getAIMetrics();
    const checks = [...(readiness.checks || [])];
    const activeCfg = adminConfig?.active || {};
    const webEnabled = activeCfg.webSearch?.enabled !== false;
    const webConfigured = Boolean(config.geminiKey);
    if (!checks.some(item => item.name === 'web_search')) {
      checks.push({
        name: 'web_search',
        status: !webEnabled ? 'disabled' : (webConfigured ? 'ready' : 'not_configured'),
        reason: !webEnabled ? 'desativado na configuração publicada' : (webConfigured ? 'Google Search Grounding ativo' : 'GEMINI_API_KEY ausente')
      });
    }
    const calEnabled = activeCfg.integrations?.googleCalendar?.enabled !== false;
    const calConfigured = Boolean(
      config.googleCalendarAccessToken ||
      (config.googleClientId && config.googleClientSecret && config.googleRefreshToken) ||
      (config.googleServiceAccountEmail && config.googleServiceAccountPrivateKey) ||
      config.googleCalendarApiKey
    );
    if (!checks.some(item => item.name === 'calendar')) {
      checks.push({
        name: 'calendar',
        status: !calEnabled ? 'disabled' : (calConfigured ? 'ready' : 'not_configured'),
        reason: !calEnabled ? 'desativado na configuração publicada' : (calConfigured ? 'credenciais Google Calendar ativas' : 'credenciais OAuth2/Service Account não configuradas')
      });
    }
    return json(res, 200, {
      ok: true,
      liveness: { status: 'alive', uptimeSeconds: Math.round(process.uptime()) },
      readiness: { status: readiness.status, ok: readiness.ok, checks },
      system: {
        provider: runtimeAI().provider,
        model: runtimeAI().model,
        instance: config.evolutionInstance || null,
        revision: adminConfig?.revision || 0,
        circuitBreakers: metrics.circuitBreakers || getCircuitBreakers()
      }
    });
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/models') {
    const provider = u.searchParams.get('provider');
    if (provider) {
      const freeOnly = provider === 'cloudflare' || (provider === 'openrouter' && adminConfig?.draft?.ai?.openrouterFreeOnly !== false);
      const result = await listProviderModels(provider, { forceRefresh: u.searchParams.get('refresh') === 'true', freeOnly });
      return json(res, result.ok ? 200 : (result.error === 'provider_not_supported' ? 400 : 502), result);
    }
    return json(res, 200, { activeProvider: runtimeAI().provider, openrouterModels: OPENROUTER_FREE_MODELS, configuredModel: runtimeAI().model, fallbackModels: runtimeAI().fallbackModels, providers: getCircuitBreakers() });
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/agent-structure') {
    const activeCfg = adminConfig?.active || {};
    const enabledToolsMap = activeCfg.tools?.enabled || {};
    const webEnabled = activeCfg.webSearch?.enabled !== false;
    const testText = u.searchParams.get('testText');
    const hasDocument = u.searchParams.get('hasDocument') === 'true';
    const hasTools = u.searchParams.get('hasTools') !== 'false';
    const routePreview = typeof testText === 'string' && testText.trim()
      ? {
          requiredCapabilities: detectarCapacidadesExigidas(testText, { hasTools, hasDocumentContext: hasDocument }),
          decision: decidirModeloPorContexto({
            text: testText,
            historyLength: Number(u.searchParams.get('historyLength')) || 2,
            isOwner: u.searchParams.get('actor') === 'owner',
            hasTools,
            hasDocumentContext: hasDocument,
            preferredModel: activeCfg.ai?.activeModel || runtimeAI().model
          })
        }
      : null;
    return json(res, 200, {
      ...AI_AGENT_STRUCTURE,
      modelCapabilities: MODEL_CAPABILITIES,
      runtime: {
        activeProvider: activeCfg.ai?.activeProvider || runtimeAI().provider,
        activeModel: activeCfg.ai?.activeModel || runtimeAI().model,
        fallbackModels: activeCfg.ai?.fallbackModels || runtimeAI().fallbackModels || [],
        agentMode: activeCfg.ai?.agentMode || 'super_agente',
        autoRouting: activeCfg.ai?.autoRouting !== false,
        enableToolCalling: activeCfg.ai?.enableToolCalling !== false,
        contextTurns: activeCfg.ai?.contextTurns || 24,
        maxStoredHistory: activeCfg.ai?.maxStoredHistory || 100,
        maxOutputTokens: activeCfg.ai?.maxOutputTokens || 2048,
        revision: adminConfig?.revision || 0
      },
      voice: activeCfg.voice || {},
      googleCalendar: activeCfg.integrations?.googleCalendar || {},
      toolsSummary: ALL_TOOLS.map(tool => ({
        name: tool.name,
        description: tool.description,
        enabled: enabledToolsMap[tool.name] !== false && (tool.name !== 'consultar_web' || webEnabled),
        clientAllowed: isClientToolAllowed(tool.name)
      })),
      faqCount: Array.isArray(activeCfg.knowledge?.faq) ? activeCfg.knowledge.faq.filter(item => item.enabled !== false).length : 0,
      routePreview
    });
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/metrics') {
    let metrics;
    try {
      metrics = await operationsStore.listPersistentCalls(adminConfig?.active?.ai || {});
      metrics.circuitBreakers = getCircuitBreakers();
    } catch (error) {
      metrics = getAIMetrics();
      metrics.source = 'memory';
      metrics.scope = 'somente chamadas desta instância/processo';
      metrics.persistenceError = error?.code || 'metrics_persistence_unavailable';
      metrics.estimatedCost = {
        currency: 'USD', estimate: true, period: 'mês corrente UTC', totalUsd: null, knownUsd: 0, complete: false,
        missingRateModels: [], note: 'Custo não calculado: telemetria persistente ou tabela de tarifas não disponível.'
      };
    }
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
        handoffWaiting: sessions.filter(s => isHumanHandoffActive(s)).length
      }
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/metrics/reset') {
    resetMetrics();
    let auditLogged = false;
    try { await operationsStore?.audit({ actorId: req.dashboardAuth?.userId, action: 'in_memory_metrics_reset', entityType: 'ai_metrics', metadata: { source: 'dashboard', status: 'memory_only' } }); auditLogged = true; } catch {}
    return json(res, 200, { ok: true, scope: 'memory_only', persistentHistoryUntouched: true, auditLogged });
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/ping-ai') {
    const body = await readBody(req).catch(() => ({}));
    const active = runtimeAI(); const pingRes = await pingAI(body?.provider || active.provider, body?.model || active.model, { budgetGate: aiBudgetGate, aiConfig: adminConfig?.active?.ai || {} });
    return json(res, 200, pingRes);
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/voice-status') {
    return json(res, 200, { ok: true, status: getVoiceRuntimeStatus() });
  }

  if (req.method === 'GET' && u.pathname === '/api/dashboard/vps-monitor') {
    const payload = await readVpsMetrics();
    return json(res, 200, payload);
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/tts') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return json(res, 400, { error: 'text_required' });
    const voiceName = typeof body?.voiceName === 'string' ? body.voiceName.trim() : (adminConfig?.active?.voice?.voiceName || 'Aoede');
    const result = await synthesizeVoice(text, { voiceName, botConfig: adminConfig?.active });
    if (!result || !result.base64) return json(res, 503, { ok: false, error: 'tts_synthesis_failed' });
    return json(res, 200, {
      ok: true,
      audioBase64: result.base64,
      mimeType: result.mimeType || 'audio/wav',
      voiceName: result.voiceName || voiceName,
      engine: result.engine || 'unknown'
    });
  }
  return NOT_HANDLED;
}
