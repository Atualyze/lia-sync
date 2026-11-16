import { json, readBody, formatPhoneNumber, formatActivityTime, NOT_HANDLED } from './utils.mjs';
import { config } from '../config.mjs';
import { validPhone } from '../dashboard.mjs';
import { sendText, deleteChatForSync } from '../whatsapp.mjs';
import { getAIMetrics, getCircuitBreakers, resetMetrics, pingAI, OPENROUTER_FREE_MODELS, synthesizeVoice, getVoiceRuntimeStatus } from '../ai.mjs';
import { AI_AGENT_STRUCTURE } from '../knowledge.mjs';
import { listProviderModels } from '../ai/catalog.mjs';
import { MODEL_CAPABILITIES, decidirModeloPorContexto, detectarCapacidadesExigidas } from '../model-router.mjs';
import { ALL_TOOLS, isClientToolAllowed } from '../tools/index.mjs';
import { readVpsMetrics } from '../vps-monitor.mjs';
import { notifyReactivationToInternalChat } from './reactivation-notice.mjs';
import { isOwnerKey, OWNER_SELF_KEY } from '../core/identity.mjs';

// Rotas de estado/simulação/envio do painel (executadas antes das rotas /api/bridge/*).
export async function handleDashboardRoutes({ req, res, u, store, f }) {
  if (req.method === 'GET' && u.pathname === '/api/dashboard/state') {
    await store.refresh?.();
    const mode = u.searchParams.get('mode') || 'all';
    const allEntries = Object.entries(store.sessions || {});
    let realCount = 0;
    let simCount = 0;
    let handoffCount = 0;
    for (const [k, s] of allEntries) {
      const isSim = k.startsWith('sim:') || s?.origin === 'simulation';
      if (isSim) simCount++;
      else realCount++;
      if (s?.human) handoffCount++;
    }

    const sessions = allEntries
      .filter(([key, s]) => {
        const isSim = key.startsWith('sim:') || s?.origin === 'simulation';
        if (mode === 'all') return true;
        return mode === 'simulation' ? isSim : !isSim;
      })
      .map(([key, s]) => {
        const rawPhone = s.phone || key.replace(/^sim:/, '');
        const isCopilotSelf = isOwnerKey(rawPhone) || isOwnerKey(key);
        const phoneFormatted = isCopilotSelf ? 'Canal Interno Copiloto' : formatPhoneNumber(rawPhone);
        const clientName = (s.clientName || s.contactName || s.pushName || (isCopilotSelf ? 'Copiloto Interno (Gestor)' : '')).trim();
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
          phone: key.startsWith('sim:') ? key : rawPhone,
          rawPhone,
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
    const answer = await store.enqueue(body.phone, async () => {
      const reply = await f.process({
        phone: body.phone,
        text: body.text,
        origin: 'simulation',
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
      const answer = await store.enqueue(OWNER_SELF_KEY, () => f.process({
        phone: OWNER_SELF_KEY,
        text,
        origin: 'dashboard'
      }));
      await store.flush?.().catch(() => {});
      return json(res, 200, { ok: true, sent: true, internal: true, answer: answer || null });
    }
    const phone = rawPhone;
    const safeReplyTo = body.replyTo && typeof body.replyTo === 'object'
      ? {
          sender: String(body.replyTo.sender || 'Contato').slice(0, 60),
          content: String(body.replyTo.content || '').slice(0, 280),
          index: Number.isFinite(Number(body.replyTo.index)) ? Number(body.replyTo.index) : null
        }
      : null;
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
      createdAt: new Date().toISOString(),
      ...(safeReplyTo ? { replyTo: safeReplyTo } : {})
    });
    session.lastBotAt = new Date().toISOString();
    session.updatedAt = new Date().toISOString();
    store.markDirty();
    let sent = false;
    let sendError = null;
    const outboundText = safeReplyTo
      ? `> _"${safeReplyTo.content.replace(/\s+/g, ' ').slice(0, 100)}"_\n\n${text}`
      : text;
    try {
      await sendText(phone, outboundText);
      sent = true;
    } catch (err) {
      sendError = err.message;
      console.error('[dashboard/send] falha ao enviar WhatsApp:', err.message);
    }
    await store.flush?.().catch(() => {});
    return json(res, 200, { ok: true, sent, error: sendError });
  }
  return NOT_HANDLED;
}

// Modo/limpeza/configuração do painel (executadas depois das rotas /api/bridge/*).
export async function handleDashboardSettingsRoutes({ req, res, u, store, runtimeAI, adminConfig = null }) {
  if (req.method === 'POST' && u.pathname === '/api/dashboard/mode') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    if (!validPhone(body.phone) || !['human', 'bot'].includes(body.mode)) return json(res, 400, { error: 'invalid_mode_or_phone' });
    const session = store.get(body.phone);
    const wasHuman = Boolean(session.human);
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
      if (wasHuman) {
        notifyReactivationToInternalChat({ store, session, phone: body.phone });
      }
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
    if (simulation) {
      await store.archive(`sim:${body.phone}`, body.reason || 'simulação encerrada');
    } else {
      const syncCfg = adminConfig?.active?.sync || {};
      if (syncCfg.whatsappSyncEnabled) {
        await store.softDeleteConversation?.({
          key: body.phone,
          source: 'dashboard',
          archive: syncCfg.archiveDeletedMessages !== false
        });
        await deleteChatForSync({ jid: body.phone }).catch(() => {});
      } else {
        await store.archive(body.phone, body.reason);
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
      process.env.GOOGLE_CALENDAR_ACCESS_TOKEN ||
      (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) ||
      (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) ||
      process.env.GOOGLE_CALENDAR_API_KEY
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
        handoffWaiting: sessions.filter(s => Boolean(s.human)).length
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
