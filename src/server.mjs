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
import { sendText, sendPresence, sendReaction, getInstanceOwnerPhone, sendWhatsAppAudio, sendDocument, sendImage, getMediaBase64, setOutboundSuppressionCheck, setBaileysProvider } from './whatsapp.mjs';
import { BaileysProvider } from './whatsapp/baileys-provider.mjs';
import { processWhatsAppWebhookPayload } from './http/webhook.mjs';
import { createInboundMessageScheduler } from './message-scheduler.mjs';
import { isHumanHandoffActive, canSendAutomatedClientMessage } from './flow/human-handoff-state.mjs';
import { authCache } from './dashboard.mjs';
import { processMaintenance } from './maintenance.mjs';
import { AdminConfigStore } from './admin-config.mjs';
import { SupabaseSessionStore, SupabaseAdminConfigStore, createSupabaseRuntime } from './supabase-runtime.mjs';
import { setMetricsPersistenceSink } from './metrics.mjs';
import { ReminderStore } from './reminders.mjs';
import { AgendaStore } from './agenda.mjs';
import { isOwnerKey, OWNER_SELF_KEY } from './core/identity.mjs';
import { createOutboundDispatchPreview } from './outbound-dispatch.mjs';
import { createChatwootProxy } from './http/proxy.mjs';
import { createRouter } from './http/router.mjs';
import { checkReadiness } from './http/readiness.mjs';
import { deliveryTarget, json } from './http/utils.mjs';
import { broadcastBridgeEvent } from './http/bridge.mjs';
import { CampaignStore } from './campaigns.mjs';
import { OperationsStore } from './operations.mjs';
import { AIBudgetGate } from './ai/budget.mjs';
import { WebhookEventStore } from './webhook-events.mjs';
import { SectorProjection } from './sectors.mjs';
import { TenantStore } from './tenants/store.mjs';
import { CustomSectorStore } from './sectors/custom-sectors.mjs';
import { createProspecting } from './prospecting/index.mjs';
import { IntegrationsStore } from './http/integrations-store.mjs';
import { CopilotTaskStore } from './copilot-tasks.mjs';
import { createCopilotTaskWorker } from './copilot-task-worker.mjs';
import { LiaRuntimeStore, createLiaRuntime } from './runtime/index.mjs';
import { LiaLearningStore, createLearningEngine } from './learning/index.mjs';
import { LiaAutonomyStore, createAutonomyEngine } from './autonomy/index.mjs';
import { ApiSettingsStore } from './api-settings.mjs';
import { CustomProviderStore } from './ai/custom-providers.mjs';
import { startGlobalEventLoopMonitor, stopGlobalEventLoopMonitor, getEventLoopHealthSnapshot } from './ops/event-loop-monitor.mjs';
import { redactSecrets } from './ops/log-redaction.mjs';
import { createAlertThrottle } from './ops/alert-throttle.mjs';
import { createRuntimeAlertNotifier, notifyBeforeShutdown } from './ops/runtime-alerts.mjs';
import { createTelegramCopilot } from './channels/telegram.mjs';
import { avaliarJanelaDeAtendimento } from './business-hours.mjs';
import { SupabaseInfinitePayOrderStore } from './tools/gerenciar_cobranca_pagamento.mjs';

// Fachada pública: os helpers HTTP vivem em src/http/* e continuam exportados aqui.
export { withoutHopByHopHeaders, authorized, readBody, formatPhoneNumber, formatActivityTime, deliveryTarget } from './http/utils.mjs';
export { broadcastBridgeEvent } from './http/bridge.mjs';

const supabaseRuntime = config.supabaseRuntimeEnabled ? createSupabaseRuntime({ url: config.supabaseUrl, serviceRoleKey: config.supabaseServiceRoleKey }) : { enabled: false, client: null };
const defaultStore = supabaseRuntime.enabled ? new SupabaseSessionStore(config.dataFile, { client: supabaseRuntime.client, ttlMs: config.sessionTtlMs }) : new SessionStore(config.dataFile, { ttlMs: config.sessionTtlMs });
const defaultAdminConfig = supabaseRuntime.enabled ? new SupabaseAdminConfigStore(undefined, { client: supabaseRuntime.client }) : new AdminConfigStore();

export async function createApp({ store = defaultStore, flow, dashboardAuth, webhookAuthorize, adminConfig = defaultAdminConfig, chatwootInternalUrl = config.chatwootInternalUrl, readinessCheck } = {}) {
  await store.load();
  store.paymentOrderStore = store.client?.enabled ? new SupabaseInfinitePayOrderStore({ client: store.client }) : null;
  await adminConfig.load();
  const apiSettingsStore = new ApiSettingsStore({
    client: store.client,
    filePath: path.join(path.dirname(config.dataFile), 'api-settings.json'),
    logger: console
  });
  await apiSettingsStore.load();
  const customProviderStore = new CustomProviderStore({
    client: store.client,
    filePath: path.join(path.dirname(config.dataFile), 'custom-ai-providers.json'),
    logger: console
  });
  await customProviderStore.load();
  // Preços permitidos vêm exclusivamente da configuração publicada (regra do projeto).
  setPricingSource(() => adminConfig.active);
  if (!store.client?.enabled) console.warn('[persistence] Supabase runtime desativado: configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; usando fallback local.');
  else if (store.remoteError || adminConfig.remoteError) console.warn(`[persistence] Supabase configurado, mas indisponível: ${store.remoteError || adminConfig.remoteError}`);
  else console.log('[persistence] Supabase runtime ativado e conectado com sucesso.');
  setMetricsPersistenceSink(call => store.recordAICall?.(call));
  const operationsStore = new OperationsStore({ client: store.client });
  const copilotTaskStore = new CopilotTaskStore({
    client: store.client,
    filePath: path.join(path.dirname(config.dataFile), 'copilot-tasks.json'),
    allowLocalFallback: process.env.COPILOT_TASK_LOCAL_FALLBACK === 'true',
    logger: console
  });
  await copilotTaskStore.load();
  const startupRecovery = await copilotTaskStore.recoverInterruptedOnStartup(`${os.hostname()}:${process.pid}`).catch(() => ({ recovered: 0, requeued: 0, markedUncertain: 0 }));
  if (startupRecovery.recovered > 0) {
    console.log(`[copilot-tasks] recuperação no startup: ${startupRecovery.recovered} tarefa(s) interrompida(s) (${startupRecovery.requeued} re-enfileirada(s), ${startupRecovery.markedUncertain} marcada(s) como incerta(s)).`);
  }
  const budgetGate = new AIBudgetGate({ operationsStore });
  const askAIWithBudget = args => askAI({ ...args, budgetGate });
  const copilotAI = { askAI: askAIWithBudget, transcribeAudio, analyzeDocument, searchWebWithGemini, synthesizeVoice };
  const campaignStore = new CampaignStore({ client: supabaseRuntime.client, sender: sendText });
  setOutboundSuppressionCheck(phone => campaignStore.isSuppressed(phone));
  const liaLearningStore = new LiaLearningStore({
    client: store.client,
    filePath: path.join(path.dirname(config.dataFile), 'lia-learning.json'),
    allowLocalFallback: process.env.LIA_LEARNING_LOCAL_FALLBACK === 'true',
    logger: console
  });
  const liaLearning = createLearningEngine({
    store: liaLearningStore,
    ai: copilotAI,
    isSuppressed: phone => campaignStore.isSuppressed(phone),
    logger: console
  });
  await liaLearning.start();
  const liaRuntimeStore = new LiaRuntimeStore({
    client: store.client,
    filePath: path.join(path.dirname(config.dataFile), 'lia-runtime.json'),
    allowLocalFallback: process.env.LIA_RUNTIME_LOCAL_FALLBACK === 'true',
    logger: console
  });
  let telegramCopilot = null;
  let liaAutonomy = null;
  const mirrorToTelegram = (message, options = {}) => {
    void telegramCopilot?.notifyAdmin?.(message, options).catch(() => {});
  };
  const liaRuntime = createLiaRuntime({
    store: liaRuntimeStore,
    taskStore: copilotTaskStore,
    learningEngine: liaLearning,
    getBotConfig: () => adminConfig.active,
    getHumanPhone,
    notifyCommitmentRecipient: async (commitment) => {
      const phone = String(commitment?.recipient_phone || '').replace(/\D/g, '');
      if (commitment?.recipient_type !== 'client' || !phone) return { sent: false, reason: 'client_recipient_missing' };
      const session = store.get(phone);
      const matchingConsult = session?.pendingAdminConsult?.commitmentId === commitment?.id;
      if (!canSendAutomatedClientMessage(session, { allowMatchingAdminConsult: true, hasMatchingAdminConsult: matchingConsult })) return { sent: false, reason: 'client_session_not_eligible' };
      const optOut = await campaignStore.isSuppressed(phone).catch(() => true);
      if (optOut) return { sent: false, reason: 'client_opted_out' };
      const businessWindow = avaliarJanelaDeAtendimento(adminConfig.active?.business?.hoursConfig, new Date());
      if (!businessWindow?.isOpen) return { sent: false, reason: 'outside_business_hours' };
      if (!liaAutonomy) return { sent: false, reason: 'autonomy_engine_unavailable' };

      const history = (Array.isArray(session.history) ? session.history : []).slice(-12).map(item => ({
        role: item?.role === 'assistant' ? 'assistant' : 'user',
        content: String(item?.content || '').slice(0, 1200)
      })).filter(item => item.content.trim());
      const generated = await copilotAI.askAI({
        system: [
          'Você escreve uma atualização em português brasileiro para o cliente sobre um compromisso que venceu.',
          'Use o histórico e o título/descrição do compromisso para explicar exatamente o que ainda não foi confirmado.',
          'Seja responsável, empática e direta. Não invente resultado, dado, preço, desconto ou reembolso.',
          'Não prometa novo prazo, retorno futuro, envio, contato ou ação que ainda não ocorreu.',
          'Não mencione IA, API, provedor, erro técnico ou detalhes internos.',
          'Não peça pagamento e não gere cobrança. Escreva no máximo duas frases.'
        ].join('\n'),
        history,
        userText: 'Compromisso vencido: ' + String(commitment.title || 'verificação') + '\nDetalhes: ' + String(commitment.metadata?.description || commitment.description || '') + '\nEscreva uma atualização honesta para o cliente, sem criar outra promessa.',
        botConfig: adminConfig.active,
        disableToolCalling: true,
        deadline: Date.now() + 9000
      });
      const rawReply = String(generated?.reply || '').trim();
      const filtered = filterReply(rawReply, { allowedPrices: getAllowedPrices(), strictPrices: true });
      if (!rawReply || filtered.blocked || !filtered.text) return { sent: false, reason: 'customer_update_blocked_by_safety_filter' };
      const deduplicationKey = 'tracked-commitment-overdue:' + String(commitment.id || 'unknown');
      const outcome = await liaAutonomy.decideAndAct({
        tenantId: 'default',
        why: 'Enviar atualização de um compromisso prometido que venceu, respeitando autorização e guardas de comunicação.',
        event: { id: commitment.id, type: 'commitment.due' },
        context: { commitmentId: commitment.id, category: commitment.category || 'outro', complexity: 'low' },
        proposedAction: 'follow_up',
        expectedOutcome: 'Atualização contextual entregue ao destinatário final sem criar nova promessa.',
        risk: 'low',
        confidence: 0.9,
        verificationPlan: 'confirmar envio pelo canal WhatsApp e registro no guard de comunicação',
        targetPhone: phone,
        optOut: false,
        withinBusinessHours: true,
        execute: async () => {
          const liveSession = store.get(phone);
          const liveMatchingConsult = liveSession?.pendingAdminConsult?.commitmentId === commitment?.id;
          if (!canSendAutomatedClientMessage(liveSession, {
            allowMatchingAdminConsult: true,
            hasMatchingAdminConsult: liveMatchingConsult
          })) {
            throw new Error('client_session_not_eligible');
          }
          const result = await liaAutonomy.communicateProactively({
            tenantId: 'default',
            reason: 'tracked_commitment_overdue',
            deduplicationKey,
            subject: phone,
            message: filtered.text,
            relevant: true,
            userNeedsToKnow: true,
            rightTiming: true,
            permitted: true
          });
          if (!result.sent) throw new Error(result.reason || 'proactive_communication_blocked');
          return { success: true, sent: true };
        }
      });
      if (!outcome.executed) return { sent: false, reason: outcome.authorization?.reason || outcome.reason || outcome.decision || 'follow_up_not_authorized' };
      session.history ??= [];
      session.history.push({ role: 'assistant', content: filtered.text, createdAt: new Date().toISOString(), metadata: { commitmentId: commitment.id, followUp: true } });
      session.lastBotAt = new Date().toISOString();
      session.updatedAt = new Date().toISOString();
      store.markDirty?.();
      if (typeof store.flush === 'function') await store.flush().catch(() => {});
      return { sent: true };
    },
    notifyOwner: async (message) => {
      mirrorToTelegram(message);
      const target = getHumanPhone();
      if (!target) return;
      await sendText(target, formatOutgoingMessage(message));
    },
    logger: console
  });
  const liaAutonomyStore = new LiaAutonomyStore({
    client: store.client,
    filePath: path.join(path.dirname(config.dataFile), 'lia-autonomy.json'),
    allowLocalFallback: process.env.LIA_AUTONOMY_LOCAL_FALLBACK === 'true',
    logger: console
  });
  liaAutonomy = createAutonomyEngine({
    store: liaAutonomyStore,
    runtime: liaRuntime,
    learning: liaLearning,
    taskStore: copilotTaskStore,
    isSuppressed: phone => campaignStore.isSuppressed(phone),
    notifyProactive: async ({ subject, message }) => {
      const rawSubject = String(subject || '').trim();
      const target = /^owner(?::|$)/i.test(rawSubject) ? getHumanPhone() : rawSubject.replace(/\D/g, '');
      if (!target || !message) throw new Error('proactive_message_target_or_body_missing');
      const filtered = filterReply(String(message), { allowedPrices: getAllowedPrices(), strictPrices: true });
      if (filtered.blocked || !filtered.text) throw new Error('proactive_message_blocked_by_safety_filter');
      await sendText(target, formatOutgoingMessage(filtered.text));
    },
    getBotConfig: () => adminConfig.active,
    logger: console
  });
  await liaAutonomy.start();
  await liaRuntime.start();
  const copilotTaskWorker = createCopilotTaskWorker({
    taskStore: copilotTaskStore,
    store,
    ai: copilotAI,
    getBotConfig: () => adminConfig.active,
    sendText,
    getHumanPhone,
    onOwnerNotify: (message) => mirrorToTelegram(message),
    onTaskFinished: async (task) => {
      const commitments = await liaRuntime.commitments.list();
      const linked = commitments.find(item => item.metadata?.linkedTaskId === task.id);
      if (!linked) return;
      if (task.status === 'succeeded') await liaRuntime.commitments.fulfill(linked.id);
      else if (task.status === 'uncertain') await liaRuntime.commitments.markUncertain(linked.id, task.errorCode || 'linked_task_outcome_uncertain');
      else if (task.status === 'failed') await liaRuntime.commitments.fail(linked.id, task.errorCode || 'linked_task_failed');
    },
    operationsStore,
    logger: console
  });
  copilotTaskStore.setOnEnqueue(() => {
    void copilotTaskWorker.drain().catch(error => console.error('[copilot-worker] ciclo imediato interrompido:', error?.code || error?.name || 'worker_error'));
  });

  const baseReadinessCheck = readinessCheck || checkReadiness;
  const taskQueueReadinessCheck = async () => {
    const base = await baseReadinessCheck();
    const queueMode = copilotTaskStore.mode;
    const queueAvailable = copilotTaskStore.available === true;
    const queueCheck = {
      name: 'copilot_tasks',
      status: queueAvailable ? 'ready' : 'unavailable',
      mode: queueMode,
      ...(queueMode === 'local' && copilotTaskStore.localCorrupt ? { reason: 'local_store_corrupt' } : {}),
      ...(queueMode === 'local' && !copilotTaskStore.localCorrupt ? { reason: 'single_instance_local_fallback' } : {})
    };
    const runtimeCheck = liaRuntime.readiness();
    const runtimeAvailable = runtimeCheck.status === 'ready';
    const learningCheck = liaLearning.readiness();
    const learningAvailable = learningCheck.status === 'ready';
    const autonomyCheck = liaAutonomy.readiness();
    const autonomyAvailable = autonomyCheck.status === 'ready';
    const elSnapshot = getEventLoopHealthSnapshot();
    const eventLoopCheck = {
      name: 'event_loop',
      status: 'ready',
      health: elSnapshot.status,
      recentStalls15m: elSnapshot.recentStalls15m,
      maxStallMs: elSnapshot.maxStallMs
    };
    const checks = [...(Array.isArray(base?.checks) ? base.checks : []), queueCheck, runtimeCheck, learningCheck, autonomyCheck, eventLoopCheck];
    const ok = Boolean(base?.ok) && queueAvailable && runtimeAvailable && learningAvailable && autonomyAvailable;
    return { ...base, ok, status: ok ? 'ready' : 'not_ready', checks };
  };
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

  function getHumanPhone() {
    const humanCfg = adminConfig.active.human || {};
    if (humanCfg.enabled === false) return '';
    if (humanCfg.alertDestination === 'same_as_bot') {
      return String(cachedInstanceOwner || '').replace(/\D/g, '');
    }
    const cfgPhone = String(humanCfg.phone || '').replace(/\D/g, '');
    const raw = cfgPhone || cachedInstanceOwner || config.humanPhone || '';
    return String(raw).replace(/\D/g, '');
  }

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
      const alertText = `🔔 *Aprovação de disparo automático necessária*\n\n${staged.preview}`;
      mirrorToTelegram(alertText, { withApprovalButtons: true });
      await sendText(operatorPhone, alertText);
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
  const agendaStore = new AgendaStore(path.join(path.dirname(config.dataFile), 'agenda.json'), { client: supabaseRuntime.client });
  await agendaStore.load();
  // Projeção de runtime dos setores do Chatwoot: nunca entra em rascunho/revisão do painel.
  const sectorProjection = new SectorProjection(path.join(path.dirname(config.dataFile), 'sectors-projection.json'), { client: supabaseRuntime.client });
  await sectorProjection.load();
  const tenantStore = new TenantStore(undefined, { client: supabaseRuntime.client });
  await tenantStore.load();
  const customSectorStore = new CustomSectorStore(undefined, { client: supabaseRuntime.client });
  await customSectorStore.load();

  const getTelemetry = async () => {
    let evoState = 'desconhecido';
    if (config.whatsappProvider === 'baileys' && baileysProvider) {
      evoState = baileysProvider.status === 'connected' ? 'connected' : baileysProvider.status;
      if (baileysProvider.connectedPhone) {
        cachedInstanceOwner = baileysProvider.connectedPhone;
      }
    } else if (config.whatsappProvider === 'manychat') {
      evoState = (config.manychatToken && config.manychatReplyFieldId && config.manychatSendflowNs)
        ? 'connected'
        : 'not_configured';
    } else if (config.whatsappProvider === 'ghl') {
      evoState = config.ghlToken ? 'connected' : 'not_configured';
    } else if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) {
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
    const waitingContacts = activeSessions.filter(s => isHumanHandoffActive(s)).map(s => ({
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
      },
      telegram: telegramCopilot?.getStatus?.() || { configured: false, status: 'not_configured' }
    };
  };

  const f = flow || createFlow({
    store,
    ai: copilotAI,
    faq: faqWithAdmin,
    getBotConfig: () => adminConfig.active,
    adminConfig,
    whatsapp: { sendText, sendWhatsAppAudio, sendDocument, sendImage, getMediaBase64, sendReaction },
    getHumanPhone,
    reminderStore,
    operationsStore,
    copilotTaskStore,
    liaRuntime,
    getTelemetry,
    getSectors: () => sectorProjection.active(),
    allowClientResume: config.humanAllowClientResume,
    maxInputChars: config.maxInputChars,
    rateLimitMax: config.rateLimitMax,
    rateLimitWindowMs: config.rateLimitWindowMs,
    onOwnerNotify: (message) => mirrorToTelegram(message)
  });
  telegramCopilot = createTelegramCopilot({
    getConfig: () => config,
    flow: f,
    store,
    transcribeAudio,
    broadcastBridgeEvent,
    logger: console
  });
  const runtimeAI = () => {
    const provider = String(adminConfig.active.ai?.activeProvider || '').trim();
    const model = String(adminConfig.active.ai?.activeModel || '').trim();
    const fallbackModels = Array.isArray(adminConfig.active.ai?.fallbackModels)
      ? adminConfig.active.ai.fallbackModels
      : [];
    return { provider, model, fallbackModels };
  };
  const integrationsStore = new IntegrationsStore({ client: supabaseRuntime.client });
  await integrationsStore.load().catch(() => {});
  const auth = dashboardAuth || authCache();
  const rateMessage = 'Recebi muitas mensagens em pouco tempo por aqui! ⏳\n\nVou pausar nosso atendimento por alguns minutinhos para organizar tudo com calma. Logo em seguida você já pode escrever novamente! 💛';
  const deliver = (job) => {
    let outboundStarted = false;
    return store.enqueue(job.phone, async () => {
      const incomingSession = store.get(job.phone);
      const activeInst = getActiveInstancePhone();
      if (incomingSession && activeInst && !isOwnerKey(job.phone) && job.origin !== 'simulation') {
        if (incomingSession.instancePhone !== activeInst) {
          incomingSession.instancePhone = activeInst;
          store.markDirty?.();
        }
      }
      const wasHuman = isHumanHandoffActive(incomingSession);
      void integrationsStore.dispatchEvent('message.received', { phone: job.phone, text: job.text || '', mediaType: job.mediaType || 'text' }).catch(() => {});
      if (!wasHuman) {
        void sendPresence(deliveryTarget(job, getHumanPhone()), job.mediaType === 'audio' ? 'recording' : 'composing', 4000);
      }
      const answer = await f.process({ ...job, messageId: job.keyId || '' });
      if (!wasHuman && isHumanHandoffActive(store.get(job.phone))) {
        void integrationsStore.dispatchEvent('handoff.triggered', { phone: job.phone, text: job.text || '' }).catch(() => {});
      }
      if (!answer) {
        console.info('[deliver] sem resposta para envio', JSON.stringify({ suffix: String(job.phone || '').slice(-6), wasHuman, human: isHumanHandoffActive(store.get(job.phone)) }));
        return null;
      }
      // Ponto único de saída: nenhuma resposta chega ao WhatsApp sem passar por filterReply.
      const copilotTarget = isOwnerKey(job.phone);
      const serverAllowedPrices = copilotTarget ? new Set() : new Set(getAllowedPrices());
      if (!copilotTarget && /^💳\s*\*Aqui está seu (?:Pix|link de pagamento)/i.test(String(answer).trim())) {
        const receiptPrices = String(answer).matchAll(/R\$\s*(\d+(?:[.,]\d{2})?)/gi);
        for (const m of receiptPrices) {
          if (m[1]) serverAllowedPrices.add(m[1]).add(m[1].replace(',', '.')).add(m[1].replace('.', ','));
        }
      }
      const filteredReply = filterReply(String(answer), {
        isCopilot: copilotTarget,
        allowedPrices: serverAllowedPrices,
        strictPrices: !copilotTarget
      });
      const safeAnswer = filteredReply.blocked && !copilotTarget
        ? 'Quero te orientar com segurança, por isso encaminhei sua mensagem para nossa equipe avaliar e responder com cuidado.'
        : filteredReply.text;
      const parts = splitReply(formatOutgoingMessage(safeAnswer));
      for (let i = 0; i < parts.length; i++) {
        if (i) await new Promise(resolve => setTimeout(resolve, 600));
        outboundStarted = true;
        await sendText(deliveryTarget(job, getHumanPhone()), parts[i]);
        broadcastBridgeEvent('bot_reply', {
          phone: job.phone,
          text: parts[i],
          timestamp: Date.now()
        });
      }
      if (incomingSession?.sendFailed) {
        incomingSession.sendFailed = false;
        store.markDirty?.();
      }
      return answer;
    }).catch(error => {
      const session = store.get(job.phone);
      if (outboundStarted && session) {
        session.sendFailed = true;
        store.markDirty?.();
      }
      const failure = new Error(error?.message || String(error || 'delivery_failed'), { cause: error });
      if (error?.code) failure.code = error.code;
      failure.deliveryOutcomeUncertain = outboundStarted;
      console.error('[webhook]', failure.message);
      throw failure;
    });
  };

  const inboundScheduler = createInboundMessageScheduler({
    deliver,
    delayMs: config.debounceMs,
    isImmediate: job => Boolean(
      job.nonText ||
      ['audio', 'image', 'video'].includes(String(job.mediaType || '').toLowerCase()) ||
      isOwnerKey(job.phone)
    ),
    onError: (error, context) => {
      console.error('[webhook:scheduler]', context?.phase || 'delivery_failed', error?.message || error);
    }
  });
  const schedule = inboundScheduler.schedule;
  const drainPending = inboundScheduler.drain;
  const proxyToChatwoot = createChatwootProxy({ chatwootInternalUrl });
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
  const baileysProvider = new BaileysProvider({
    authDir: config.baileysAuthDir,
    client: store.client,
    logger: console,
    onStateChange: (status) => {
      if (status?.phone) cachedInstanceOwner = status.phone;
      broadcastBridgeEvent('baileys_status', { ...status, activeEngine: config.whatsappProvider });
    },
    onEvent: async (payload) => {
      await processWhatsAppWebhookPayload({
        payload,
        store,
        f,
        adminConfig,
        schedule,
        getHumanPhone,
        getCachedInstanceOwner,
        updateInstanceOwner,
        rateMessage,
        webhookEventStore,
        campaignStore,
        prospecting
      });
    }
  });
  setBaileysProvider(baileysProvider);
  const getActiveInstancePhone = () => {
    const bpPhone = baileysProvider?.getStatus?.()?.status === 'connected' ? (baileysProvider.getStatus().phone || '') : '';
    const raw = bpPhone || cachedInstanceOwner || '';
    return String(raw).replace(/@.*$/, '').replace(/\D/g, '');
  };

  const deliverPendingAIReply = async (target, replyText, session) => {
    const dest = deliveryTarget(target || session?.phone || '');
    if (!dest || !replyText) return;
    const parts = splitReply(replyText);
    for (const part of parts) {
      await sendText(dest, formatOutgoingMessage(part));
    }
    broadcastBridgeEvent('outbound_message', {
      phone: session?.phone || dest,
      content: replyText,
      source: 'ai_retry'
    });
  };
  const deliverReactivationReply = async (target, replyText, session) => {
    const dest = deliveryTarget(target || session?.phone || '');
    if (!dest || !replyText) return;
    const parts = splitReply(replyText);
    for (const part of parts) {
      await sendText(dest, formatOutgoingMessage(part));
    }
    broadcastBridgeEvent('outbound_message', {
      phone: session?.phone || dest,
      content: replyText,
      source: 'reactivation_auto'
    });
  };
  let aiRetryRunning = false;
  const runPendingAIRetries = async ({ immediate = false } = {}) => {
    if (aiRetryRunning) return { processed: 0, delivered: 0 };
    aiRetryRunning = true;
    try {
      return await f.processPendingAIRetries({ immediate, sendReply: deliverPendingAIReply });
    } catch (error) {
      console.error('[ai-retry] Falha ao processar fila silenciosa de retentativas:', error?.message || error);
      return { processed: 0, delivered: 0 };
    } finally {
      aiRetryRunning = false;
    }
  };
  const onAIConfigUpdated = (reason = '') => {
    void runPendingAIRetries({ immediate: true });
    if (reason === 'api_settings_updated') {
      void telegramCopilot?.reload?.().catch(err => console.error('[telegram] Falha ao recarregar após salvar configurações:', redactSecrets(err?.message || String(err))));
    }
  };

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
    readinessCheck: taskQueueReadinessCheck,
    campaignStore,
    operationsStore,
    webhookEventStore,
    aiBudgetGate: budgetGate,
    sectorProjection,
    tenantStore,
    customSectorStore,
    prospecting,
    askAI: askAIWithBudget,
    integrationsStore,
    liaRuntime,
    liaLearning,
    liaAutonomy,
    apiSettingsStore,
    customProviderStore,
    baileysProvider,
    copilotTaskStore,
    agendaStore,
    reminderStore,
    onAIConfigUpdated,
    deliverReactivationReply,
    getActiveInstancePhone,
    notifyCopilot: async (message) => {
      if (!message) return;
      void telegramCopilot?.notifyAdmin?.(message).catch((err) => console.error('[notifyCopilot:tg]', err?.message || err));
      const humanPhone = getHumanPhone?.();
      if (!humanPhone) {
        console.info('[notifyCopilot:wa] sem humanPhone configurado');
        return;
      }
      await sendText(humanPhone, message).catch((err) => console.error('[notifyCopilot:wa]', err?.message || err));
    }
  });
  app.store = store; app.flow = f; app.adminConfig = adminConfig; app.reminderStore = reminderStore; app.agendaStore = agendaStore; app.getHumanPhone = getHumanPhone; app.getActiveInstancePhone = getActiveInstancePhone; app.deliverReactivationReply = deliverReactivationReply; app.prospecting = prospecting; app.stageAutomatedOutbound = stageAutomatedOutbound; app.copilotTaskStore = copilotTaskStore; app.copilotTaskWorker = copilotTaskWorker; app.liaRuntime = liaRuntime; app.liaLearning = liaLearning; app.liaAutonomy = liaAutonomy; app.apiSettingsStore = apiSettingsStore; app.customProviderStore = customProviderStore; app.baileysProvider = baileysProvider; app.telegramCopilot = telegramCopilot; app.runPendingAIRetries = runPendingAIRetries; app.drainPending = drainPending; app.schedule = schedule; return app;
}

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isDirectRun) {
  const errors = validateConfig(); if (errors.length) { console.error(`[config] ${errors.join('; ')}`); process.exit(1); }
  startGlobalEventLoopMonitor({ logger: console });
  const app = await createApp(); const store = app.store; const server = http.createServer((req, res) => app(req, res).catch(e => { console.error(redactSecrets(e?.stack || e?.message || String(e))); if (!res.headersSent) json(res, 500, { error: 'internal_error' }); }));
  const runtimeAlertThrottle = createAlertThrottle({ windowMs: 10 * 60_000 });
  const notifyRuntimeAlert = createRuntimeAlertNotifier({
    throttle: runtimeAlertThrottle,
    getWhatsAppTarget: () => app.getHumanPhone?.(),
    sendWhatsApp: (target, message) => sendText(target, message),
    getTelegramNotifier: () => app.telegramCopilot?.notifyAdmin
      ? message => app.telegramCopilot.notifyAdmin(message)
      : null,
    redact: message => redactSecrets(message),
    formatWhatsAppMessage: message => formatOutgoingMessage(message),
    logger: console
  });
  if (config.whatsappProvider === 'baileys') {
    void app.baileysProvider?.start().catch(err => console.error('[baileys] Falha na inicialização automática:', err?.message || err));
  }
  if (config.telegramBotToken) {
    void app.telegramCopilot?.start().catch(err => console.error('[telegram] Falha na inicialização automática:', redactSecrets(err?.message || String(err))));
  }
  // Conexões SSE (/api/bridge/events) usam req.setTimeout(0) no handler; keepAlive alinhado ao proxy
  server.requestTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 65_000;
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
      void notifyRuntimeAlert(
        'maintenance_lease_unavailable',
        '⚠️ *Lia Sync: manutenção pausada*\n\nA reivindicação do lease distribuído falhou. A manutenção automática ficará pausada nesta réplica até a conectividade com o Supabase/RPC ser restabelecida.\n\n*Diagnóstico:* ' + redactSecrets(error?.message || error?.code || error?.name || 'lease_unavailable').slice(0, 500)
      ).catch(() => {});
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
      notify: (app.getHumanPhone() || config.telegramBotToken)
        ? async (message) => {
            void app.telegramCopilot?.notifyAdmin?.(message).catch(() => {});
            if (app.getHumanPhone()) await sendText(app.getHumanPhone(), message);
          }
        : undefined,
      reminderStore: app.reminderStore,
      timeZone: config.businessTimeZone,
      staleHours: config.inactivityStaleHours,
      humanReminderMinutes: config.humanReminderMinutes,
      humanPhone: app.getHumanPhone(),
      activeInstancePhone: app.getActiveInstancePhone?.() || '',
      disableInactivityPings: true,
      enableLeadFollowUp: app.adminConfig.active.behavior?.leadFollowUpEnabled !== false,
      followUpMinHours: app.adminConfig.active.behavior?.leadFollowUpMinHours ?? 24,
      followUpMaxHours: app.adminConfig.active.behavior?.leadFollowUpMaxHours ?? 72,
      autoResumeOnOpen: app.adminConfig.active.business?.hoursConfig?.autoResumeOnOpen !== false,
      onPostponedResume: async (session) => {
        if (!session?.phone || isHumanHandoffActive(session) || session.archivedAt) return { continued: false };
        const history = Array.isArray(session.history) ? session.history : [];
        const lastUser = [...history].reverse().find(m => m?.role === 'user' && String(m.content || '').trim());
        if (!lastUser) return { continued: false };
        const lastMs = Date.parse(lastUser.createdAt || session.lastUserAt || '');
        if (Number.isFinite(lastMs) && Date.now() - lastMs > 72 * 3600000) return { continued: false };
        const text = String(lastUser.content || '').trim();
        const run = async () => {
          const live = store.get?.(session.phone) || session;
          if (!live || isHumanHandoffActive(live) || live.archivedAt) return { continued: false };
          const reply = await app.flow.process({
            phone: live.phone,
            text,
            origin: 'reactivation_auto',
            nonText: false,
            mediaType: 'text',
            rawItem: { jid: live.rawJid || live.phone },
            pushName: live.clientName || '',
            messageId: ''
          });
          if (!reply) return { continued: false };
          await app.deliverReactivationReply?.(live.rawJid || live.phone, reply, live);
          return { continued: true };
        };
        return typeof store.enqueue === 'function' ? await store.enqueue(session.phone, run) : await run();
      }
      }).catch(e => console.error('[maintenance]', e.message));
      await app.liaRuntime?.wake({ reason: 'scheduler' }).catch(e => console.error('[lia-runtime]', e.message));
      return await app.prospecting?.tick({ stageOutboundDispatch: app.stageAutomatedOutbound });
    } finally {
      maintenanceRunning = false;
    }
  };
  const maintenanceTimer = setInterval(maintenance, Math.max(30, config.inactivityCheckSeconds) * 1000); maintenanceTimer.unref();
  // Scheduler dedicado do Lia Runtime (15s): garante que compromissos/verificações autônomas
  // disparem no horário exato sem depender do intervalo longo de manutenção de inatividade.
  let runtimeWakeRunning = false;
  let lastDailyReviewDay = '';
  const runRuntimeScheduler = async () => {
    if (runtimeWakeRunning) return;
    if (!app.liaRuntime?.available) {
      void notifyRuntimeAlert(
        'lia_runtime_unavailable',
        '⚠️ *Lia Runtime indisponível*\n\nO agendador detectou que o Runtime não está disponível. Verifique a persistência/migration do Lia Runtime e o endpoint /ready.'
      ).catch(() => {});
      return;
    }
    runtimeWakeRunning = true;
    try {
      await app.liaRuntime.wake({ reason: 'scheduler' });
      if (app.liaAutonomy?.readiness?.().status === 'ready') {
        let identity = null;
        try { identity = await app.liaRuntime.identity?.get?.(); } catch {}
        const configuredHour = Number(identity?.owner_preferences?.digestHour ?? 9);
        const reviewHour = Number.isInteger(configuredHour) && configuredHour >= 0 && configuredHour <= 23 ? configuredHour : 9;
        const activeConfig = app.adminConfig?.active || {};
        let timeZone = activeConfig.businessHours?.timezone
          || activeConfig.business?.hoursConfig?.timezone
          || activeConfig.business?.timezone
          || 'America/Sao_Paulo';
        let localHour;
        try {
          localHour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
        } catch {
          timeZone = 'America/Sao_Paulo';
          localHour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
        }
        const dateParts = new Intl.DateTimeFormat('en-US', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).formatToParts(new Date());
        const dateValues = Object.fromEntries(dateParts.map(part => [part.type, part.value]));
        const reviewDay = `${dateValues.year}-${dateValues.month}-${dateValues.day}`;
        if (Number.isFinite(localHour) && localHour >= reviewHour && lastDailyReviewDay !== reviewDay) {
          lastDailyReviewDay = reviewDay;
          await app.liaAutonomy.runDailyReview({ tenantId: 'default', timeZone });
        }
      }
    } catch (e) {
      console.error('[lia-runtime]', e?.message || e);
    } finally {
      runtimeWakeRunning = false;
    }
  };
  const runtimeSchedulerTimer = setInterval(() => { void runRuntimeScheduler(); }, 15_000);
  runtimeSchedulerTimer.unref();
  // Worker independente: reivindica jobs persistentes com lease no Supabase.
  // O intervalo não sobrepõe execuções locais; concorrência entre réplicas é controlada pela RPC claim_copilot_task.
  const runCopilotWorker = () => {
    if (app.copilotTaskStore?.available !== true) {
      void notifyRuntimeAlert(
        'copilot_queue_unavailable',
        '⚠️ *Fila do Copiloto indisponível*\n\nA fila persistente de tarefas não está disponível. Novas tarefas em segundo plano podem ficar aguardando recuperação. Verifique Supabase, migrations e /ready.'
      ).catch(() => {});
      return;
    }
    app.copilotTaskWorker?.drain().catch(error => {
      console.error('[copilot-worker] ciclo interrompido:', error?.code || error?.name || 'worker_error');
      void notifyRuntimeAlert(
        'copilot_worker_failed',
        '⚠️ *Worker do Copiloto com falha*\n\nO ciclo de execução da fila foi interrompido.\n\n*Diagnóstico:* ' + redactSecrets(error?.message || error?.code || error?.name || 'worker_error').slice(0, 500)
      ).catch(() => {});
    });
  };
  runCopilotWorker();
  const copilotTaskTimer = setInterval(runCopilotWorker, 3000);
  copilotTaskTimer.unref();
  const aiRetryTimer = setInterval(() => {
    void app.runPendingAIRetries?.({ immediate: false });
  }, 10_000);
  aiRetryTimer.unref();
  let stopping = false;
  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    const forceExit = setTimeout(() => process.exit(exitCode), 12_000);
    forceExit.unref?.();
    const serverClosed = new Promise(resolve => server.close(() => resolve()));
    clearInterval(maintenanceTimer);
    clearInterval(runtimeSchedulerTimer);
    clearInterval(copilotTaskTimer);
    clearInterval(aiRetryTimer);
    stopGlobalEventLoopMonitor();
    await app.telegramCopilot?.stop().catch(() => {});
    await app.baileysProvider?.stop({ logout: false }).catch(() => {});
    await app.drainPending?.();
    await Promise.allSettled([...(store.queues?.values?.() || [])]);
    await store.flush().catch(() => {});
    server.closeIdleConnections?.();
    await serverClosed;
    process.exit(exitCode);
  };
  process.on('SIGTERM', () => { void stop(0); });
  process.on('SIGINT', () => { void stop(0); });
  process.on('unhandledRejection', (reason) => {
    const detail = redactSecrets(reason?.stack || reason?.message || String(reason)).slice(0, 1200);
    console.error('[process] unhandledRejection:', detail);
    void notifyRuntimeAlert('process_unhandled_rejection', '⚠️ *Lia Sync: rejeição não tratada*\n\nO processo continua ativo, mas uma Promise falhou sem tratamento.\n\n*Diagnóstico:* ' + detail).catch(() => {});
  });
  process.on('uncaughtException', (error) => {
    const detail = redactSecrets(error?.stack || error?.message || String(error)).slice(0, 1200);
    console.error('[process] uncaughtException; iniciando encerramento controlado:', detail);
    void notifyBeforeShutdown({
      notify: () => notifyRuntimeAlert('process_uncaught_exception', '🚨 *Lia Sync: exceção não tratada*\n\nO processo iniciará um encerramento controlado para evitar continuar em estado inconsistente.\n\n*Diagnóstico:* ' + detail),
      stop,
      timeoutMs: 2500
    }).catch(() => {});
  });
}
