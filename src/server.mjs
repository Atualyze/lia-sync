import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateConfig } from './config.mjs';
import { SessionStore } from './sessions.mjs';
import { createFlow } from './flow.mjs';
import { splitReply, filterReply } from './safety.mjs';
import { setPricingSource, getAllowedPrices } from './faq.mjs';
import { formatOutgoingMessage } from './core/format.mjs';
import { askAI, getCircuitBreakers, transcribeAudio, analyzeDocument, searchWebWithGemini, synthesizeVoice } from './ai.mjs';
import { loadFaq } from './faq.mjs';
import { sendText, sendPresence, getInstanceOwnerPhone, sendWhatsAppAudio, sendDocument, sendImage, getMediaBase64, setOutboundSuppressionCheck } from './whatsapp.mjs';
import { authCache } from './dashboard.mjs';
import { processMaintenance } from './maintenance.mjs';
import { AdminConfigStore } from './admin-config.mjs';
import { SupabaseSessionStore, SupabaseAdminConfigStore, createSupabaseRuntime } from './supabase-runtime.mjs';
import { setMetricsPersistenceSink } from './metrics.mjs';
import { ReminderStore } from './reminders.mjs';
import { isOwnerKey, OWNER_SELF_KEY } from './core/identity.mjs';
import { createOutboundDispatchPreview } from './outbound-dispatch.mjs';
import { createChatwootProxy } from './http/proxy.mjs';
import { createRouter } from './http/router.mjs';
import { deliveryTarget, json } from './http/utils.mjs';
import { broadcastBridgeEvent } from './http/bridge.mjs';
import { CampaignStore } from './campaigns.mjs';
import { OperationsStore } from './operations.mjs';
import { AIBudgetGate } from './ai/budget.mjs';
import { WebhookEventStore } from './webhook-events.mjs';
import { SectorProjection } from './sectors.mjs';
import { createProspecting } from './prospecting/index.mjs';
import { IntegrationsStore } from './http/integrations-store.mjs';
import { CopilotTaskStore } from './copilot-tasks.mjs';
import { createCopilotTaskRunner } from './copilot-task-runner.mjs';

// Fachada pública: os helpers HTTP vivem em src/http/* e continuam exportados aqui.
export { withoutHopByHopHeaders, authorized, readBody, formatPhoneNumber, formatActivityTime, deliveryTarget } from './http/utils.mjs';
export { broadcastBridgeEvent } from './http/bridge.mjs';

const supabaseRuntime = config.supabaseRuntimeEnabled ? createSupabaseRuntime({ url: config.supabaseUrl, serviceRoleKey: config.supabaseServiceRoleKey }) : { enabled: false, client: null };
const defaultStore = supabaseRuntime.enabled ? new SupabaseSessionStore(config.dataFile, { client: supabaseRuntime.client, ttlMs: config.sessionTtlMs }) : new SessionStore(config.dataFile, { ttlMs: config.sessionTtlMs });
const defaultAdminConfig = supabaseRuntime.enabled ? new SupabaseAdminConfigStore(undefined, { client: supabaseRuntime.client }) : new AdminConfigStore();

export async function createApp({ store = defaultStore, flow, dashboardAuth, webhookAuthorize, adminConfig = defaultAdminConfig, chatwootInternalUrl = config.chatwootInternalUrl, readinessCheck } = {}) {
  await store.load();
  await adminConfig.load();
  // Preços permitidos vêm exclusivamente da configuração publicada (regra do projeto).
  setPricingSource(() => adminConfig.active);
  if (!store.client?.enabled) console.warn('[persistence] Supabase runtime desativado: configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; usando fallback local.');
  else if (store.remoteError || adminConfig.remoteError) console.warn(`[persistence] Supabase configurado, mas indisponível: ${store.remoteError || adminConfig.remoteError}`);
  else console.log('[persistence] Supabase runtime ativado e conectado com sucesso.');
  setMetricsPersistenceSink(call => store.recordAICall?.(call));
  const operationsStore = new OperationsStore({ client: store.client });
  const budgetGate = new AIBudgetGate({ operationsStore });
  const askAIWithBudget = args => askAI({ ...args, budgetGate });
  const faqFor = (botConfig) => async () => {
    const local = await loadFaq();
    const managed = (botConfig()?.knowledge?.faq || []).filter(item => item?.enabled !== false && item?.answer && Array.isArray(item.keys));
    return [...managed, ...local.filter(item => !managed.some(custom => JSON.stringify(custom.keys) === JSON.stringify(item.keys)))];
  };
  const faqWithAdmin = faqFor(() => adminConfig.active);
  let cachedInstanceOwner = null;
  const getCachedInstanceOwner = () => cachedInstanceOwner;
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
      return String(cachedInstanceOwner || '').replace(/\D/g, '');
    }
    const cfgPhone = String(humanCfg.phone || '').replace(/\D/g, '');
    const raw = cfgPhone || cachedInstanceOwner || config.humanPhone || '';
    return String(raw).replace(/\D/g, '');
  };

  const stageAutomatedOutbound = async (prepared, options = {}) => {
    const operatorPhone = getHumanPhone();
    if (!operatorPhone) return null;
    const ownerSession = store.get(OWNER_SELF_KEY);
    const staged = createOutboundDispatchPreview(ownerSession, prepared, {
      source: options.source || 'automation',
      resumeBot: options.resumeBot === true,
      metadata: options.metadata || {}
    });
    if (!staged) return null;
    ownerSession.updatedAt = new Date().toISOString();
    store.markDirty();
    try {
      await store.flush?.();
      await sendText(operatorPhone, `🔔 *Aprovação de disparo automático necessária*\n\n${staged.preview}`);
      return staged.pending;
    } catch (error) {
      ownerSession.pendingOutboundDispatch = null;
      store.markDirty();
      console.error('[outbound-dispatch] Não foi possível persistir/notificar a prévia:', error.message);
      return null;
    }
  };

  const reminderStore = new ReminderStore(path.join(path.dirname(config.dataFile), 'reminders.json'), { client: supabaseRuntime.client });
  await reminderStore.load();

  const copilotTaskStore = new CopilotTaskStore(store.client, {
    logger,
    workerId: `${os.hostname()}:${process.pid}`
  });
  await copilotTaskStore.initialize();
  const copilotTaskRunner = new createCopilotTaskRunner({
    taskStore: copilotTaskStore,
    sessionStore: store,
    ai: { askAI: askAIWithBudget, searchWebWithGemini },
    whatsapp: { sendText },
    getBotConfig: () => adminConfig.active,
    getHumanPhone,
    operationsStore,
    logger,
    workerId: `${os.hostname()}:${process.pid}`
  });
  if (copilotTaskStore.enabled) {
    console.log('[copilot-tasks] fila durável do Copiloto conectada ao Supabase.');
  } else {
    console.warn('[copilot-tasks] fila durável indisponível; fluxo legado permanece ativo até aplicar a migration.');
  }
  // Projeção de runtime dos setores do Chatwoot: nunca entra em rascunho/revisão do painel.
  const sectorProjection = new SectorProjection(path.join(path.dirname(config.dataFile), 'sectors-projection.json'), { client: supabaseRuntime.client });
  await sectorProjection.load();

  const getTelemetry = async () => {
    let evoState = 'desconhecido';
    if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) {
      evoState = 'not_configured';
    } else {
      try {
        const r = await fetch(`${config.evolutionUrl}/instance/fetchInstances`, {
          headers: { apikey: config.evolutionKey }, signal: AbortSignal.timeout(5000)
        });
        if (r.ok) {
          const list = await r.json();
          const inst = Array.isArray(list) ? list.find(x => x.name === config.evolutionInstance) : null;
          evoState = inst ? (inst.connectionStatus || 'unknown') : 'instance_not_found';
          if (inst?.ownerJid) {
            cachedInstanceOwner = inst.ownerJid.replace(/@.*$/, '').replace(/\D/g, '');
          }
        } else {
          evoState = 'unavailable';
        }
      } catch (error) { evoState = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unavailable'; }
    }

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
        waitingForOwner: waitingContacts.length,
        waitingList: waitingContacts.slice(0, 5)
      },
      reminders: {
        pending: reminderStore.listActive().length
      }
    };
  };

  const f = flow || createFlow({
    store,
    ai: { askAI: askAIWithBudget, transcribeAudio, analyzeDocument, searchWebWithGemini, synthesizeVoice },
    faq: faqWithAdmin,
    getBotConfig: () => adminConfig.active,
    adminConfig,
    whatsapp: { sendText, sendWhatsAppAudio, sendDocument, sendImage, getMediaBase64 },
    getHumanPhone,
    reminderStore,
    operationsStore,
    copilotTaskStore,
    getTelemetry,
    getSectors: () => sectorProjection.active(),
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
  const deliver = (job) => store.enqueue(job.phone, async () => {
    const wasHuman = Boolean(store.get(job.phone)?.human);
    void integrationsStore.dispatchEvent('message.received', { phone: job.phone, text: job.text || '', mediaType: job.mediaType || 'text' }).catch(() => {});
    if (!wasHuman) {
      void sendPresence(deliveryTarget(job, getHumanPhone()), job.mediaType === 'audio' ? 'recording' : 'composing', 4000);
    }
    const answer = await f.process({ ...job, messageId: job.keyId || '' });
    if (!wasHuman && store.get(job.phone)?.human) {
      void integrationsStore.dispatchEvent('handoff.triggered', { phone: job.phone, text: job.text || '' }).catch(() => {});
    }
    if (!answer) return null;
    // Ponto único de saída: nenhuma resposta chega ao WhatsApp sem passar por filterReply.
    const copilotTarget = isOwnerKey(job.phone);
    const filteredReply = filterReply(String(answer), {
      isCopilot: copilotTarget,
      allowedPrices: copilotTarget ? new Set() : getAllowedPrices(),
      strictPrices: !copilotTarget
    });
    const safeAnswer = filteredReply.blocked && !copilotTarget
      ? 'Quero te orientar com segurança, por isso encaminhei sua mensagem para nossa equipe avaliar e responder com cuidado.'
      : filteredReply.text;
    const parts = splitReply(formatOutgoingMessage(safeAnswer));
    for (let i = 0; i < parts.length; i++) {
      if (i) await new Promise(resolve => setTimeout(resolve, 600));
      await sendText(deliveryTarget(job, getHumanPhone()), parts[i]);
      broadcastBridgeEvent('bot_reply', {
        phone: job.phone,
        text: parts[i],
        timestamp: Date.now()
      });
    }
    return answer;
  }).catch(e => { try { const session = store.get(job.phone); if (session) { session.sendFailed = true; store.markDirty(); } } catch {} console.error('[webhook]', e.message); });
  const schedule = (job) => {
    if (job.nonText || job.mediaType === 'audio' || job.mediaType === 'image' || job.mediaType === 'video' || isOwnerKey(job.phone)) {
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
  const proxyToChatwoot = createChatwootProxy({ chatwootInternalUrl });
  const campaignStore = new CampaignStore({ client: supabaseRuntime.client, sender: sendText });
  setOutboundSuppressionCheck(phone => campaignStore.isSuppressed(phone));
  const prospecting = createProspecting({
    client: supabaseRuntime.client,
    sender: sendText,
    campaignStore,
    sessionStore: store,
    adminConfig
  });
  store.resolveProspectingDispatch = async (pending, outcome) => {
    if (pending?.source !== 'prospecting') return true;
    const leadStore = prospecting.leadStore;
    const leadId = pending.leadId;
    const claimToken = pending.claimToken;
    if (!leadId || !claimToken || outcome === 'uncertain') return false;
    let updates;
    if (outcome === 'sent') {
      const nextStage = Number(pending.leadStage || 0) + 1;
      updates = {
        status: pending.hasNextStep ? 'queued' : 'contacted',
        stage: nextStage,
        last_contacted_at: new Date().toISOString(),
        next_action_at: pending.nextActionAt || null,
        attempts: Number(pending.attempts || 1),
        last_error: null
      };
    } else {
      updates = {
        status: 'queued',
        next_action_at: outcome === 'failed' ? new Date(Date.now() + 15 * 60000).toISOString() : (pending.originalNextActionAt || new Date().toISOString()),
        last_error: outcome === 'failed' ? 'copilot_dispatch_failed' : null
      };
    }
    const released = await leadStore.releaseClaim(leadId, claimToken, updates);
    if (!released) return false;
    if (outcome === 'sent') {
      await leadStore.recordEvent({
        listId: pending.listId || null,
        leadId,
        phone: pending.phone,
        eventType: 'sent',
        stage: Number(pending.leadStage || 0) + 1
      });
    }
    return true;
  };
  const webhookEventStore = new WebhookEventStore({ client: supabaseRuntime.client });
  const integrationsStore = new IntegrationsStore({ client: supabaseRuntime.client });
  await integrationsStore.load().catch(() => {});

  const app = createRouter({
    store,
    f,
    adminConfig,
    auth,
    webhookAuthorize,
    runtimeAI,
    faqFor,
    rateMessage,
    schedule,
    getHumanPhone,
    getCachedInstanceOwner,
    updateInstanceOwner,
    proxyToChatwoot,
    readinessCheck,
    campaignStore,
    operationsStore,
    webhookEventStore,
    aiBudgetGate: budgetGate,
    sectorProjection,
    prospecting,
    askAI: askAIWithBudget,
    integrationsStore
  });
  app.store = store; app.flow = f; app.adminConfig = adminConfig; app.reminderStore = reminderStore; app.getHumanPhone = getHumanPhone; app.prospecting = prospecting; app.stageAutomatedOutbound = stageAutomatedOutbound; app.copilotTaskStore = copilotTaskStore; app.copilotTaskRunner = copilotTaskRunner; return app;
}

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isDirectRun) {
  const errors = validateConfig(); if (errors.length) { console.error(`[config] ${errors.join('; ')}`); process.exit(1); }
  const app = await createApp(); const store = app.store; const server = http.createServer((req, res) => app(req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'internal_error' }); }));
  // Conexões SSE (/api/bridge/events) não podem ser mortas pelo requestTimeout padrão do Node (300s)
  server.requestTimeout = 0;
  server.headersTimeout = 65000;
  server.keepAliveTimeout = 720000;
  server.listen(config.port, config.host, () => console.log(`Lia Sync escutando em ${config.host}:${config.port}`));
  // Multi-réplica: só a réplica que obtém o lease distribuído executa manutenção,
  // garantindo um único envio de lembrete/follow-up/cobrança por vez.
  const maintenanceOwner = `${os.hostname()}:${process.pid}`;
  let leaseWarningLogged = false;
  const claimMaintenanceLease = async () => {
    if (!store.client?.enabled) return true;
    try {
      const claimed = await store.client.rpc('claim_maintenance_lease', { p_owner: maintenanceOwner, p_ttl_seconds: 300 });
      return claimed === true;
    } catch (error) {
      if (!leaseWarningLogged) {
        leaseWarningLogged = true;
        console.error('[maintenance] lease distribuído indisponível; manutenção bloqueada até aplicar a migration:', error?.code || error?.name || 'lease_unavailable');
      }
      return false;
    }
  };
  let maintenanceRunning = false;
  const maintenance = async () => {
    if (maintenanceRunning || !await claimMaintenanceLease()) return;
    maintenanceRunning = true;
    try {
      await processMaintenance({
      store,
      send: sendText,
      stageOutboundDispatch: app.stageAutomatedOutbound,
      notify: app.getHumanPhone() ? message => sendText(app.getHumanPhone(), message) : undefined,
      reminderStore: app.reminderStore,
      timeZone: config.businessTimeZone,
      staleHours: config.inactivityStaleHours,
      humanReminderMinutes: config.humanReminderMinutes,
      humanAutoResumeHours: config.humanAutoResumeHours,
      humanPhone: app.getHumanPhone(),
      disableInactivityPings: true,
      enableLeadFollowUp: app.adminConfig.active.behavior?.leadFollowUpEnabled !== false,
    followUpMinHours: app.adminConfig.active.behavior?.leadFollowUpMinHours ?? 24,
    followUpMaxHours: app.adminConfig.active.behavior?.leadFollowUpMaxHours ?? 72
      }).catch(e => console.error('[maintenance]', e.message));
      return await app.prospecting?.tick({ stageOutboundDispatch: app.stageAutomatedOutbound });
    } finally {
      maintenanceRunning = false;
    }
  };
  const maintenanceTimer = setInterval(maintenance, Math.max(30, config.inactivityCheckSeconds) * 1000); maintenanceTimer.unref();
  const copilotTaskTimer = setInterval(() => {
    void app.copilotTaskRunner?.tick();
  }, 1000);
  copilotTaskTimer.unref();
  void app.copilotTaskRunner?.tick();
  const stop = async () => {
    clearInterval(maintenanceTimer);
    clearInterval(copilotTaskTimer);
    await app.copilotTaskRunner?.stop().catch(() => {});
    for (const [phone, job] of pending.entries()) {
      clearTimeout(job.timer);
      pending.delete(phone);
      deliver(job);
    }
    await Promise.allSettled([...(store.queues?.values?.() || [])]);
    await store.flush().catch(() => {});
    const forceExit = setTimeout(() => process.exit(0), 5000);
    forceExit.unref?.();
    server.close(() => process.exit(0));
  }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
