import { json, readBody, formatPhoneNumber, formatActivityTime, NOT_HANDLED } from './utils.mjs';
import { config } from '../config.mjs';
import { validPhone } from '../dashboard.mjs';
import { sendText } from '../whatsapp.mjs';
import { getAIMetrics, getCircuitBreakers, resetMetrics, pingAI, OPENROUTER_FREE_MODELS } from '../ai.mjs';
import { AI_AGENT_STRUCTURE } from '../knowledge.mjs';

// Rotas de estado/simulação/envio do painel (executadas antes das rotas /api/bridge/*).
export async function handleDashboardRoutes({ req, res, u, store, f }) {
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
  return NOT_HANDLED;
}

// Modo/limpeza/configuração do painel (executadas depois das rotas /api/bridge/*).
export async function handleDashboardSettingsRoutes({ req, res, u, store, runtimeAI }) {
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
  return NOT_HANDLED;
}

// Modelos/estrutura/métricas/ping de IA do painel (executadas após as rotas /api/admin/*).
export async function handleDashboardRuntimeRoutes({ req, res, u, store, runtimeAI }) {
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
  return NOT_HANDLED;
}
