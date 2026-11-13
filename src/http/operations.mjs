import { json, readBody, NOT_HANDLED } from './utils.mjs';
import { config } from '../config.mjs';
import { getCircuitBreakers } from '../ai.mjs';
import { ALL_TOOLS, isClientToolAllowed } from '../tools/index.mjs';
import { isUuid, maskPhone } from '../operations.mjs';

const errorStatus = error => {
  if (['campaign_persistence_unavailable', 'campaign_worker_unavailable', 'user_management_unavailable', 'audit_persistence_unavailable', 'metrics_persistence_unavailable', 'invalid_suppression'].includes(error?.code)) return error.code === 'invalid_suppression' ? 400 : 503;
  if (['invalid_campaign', 'invalid_profile', 'invalid_suppression_reason'].includes(error?.code)) return 400;
  if (error?.code === 'profile_not_found') return 404;
  if (['cannot_change_own_admin_access', 'last_active_admin_required'].includes(error?.code)) return 409;
  return 502;
};

const publicCampaign = campaign => {
  if (!campaign) return campaign;
  const { message, created_by, recipients = [], ...summary } = campaign;
  return {
    ...summary,
    recipients: recipients.map(recipient => ({
      id: recipient.id,
      phone: maskPhone(recipient.phone),
      status: recipient.status,
      attempts: recipient.attempts,
      error: recipient.error,
      sentAt: recipient.sentAt
    }))
  };
};

async function auditBestEffort(operationsStore, event) {
  if (!operationsStore) return false;
  try { await operationsStore.audit(event); return true; }
  catch (error) { console.warn(`[audit] ação não persistida (${String(error?.code || 'audit_unavailable')})`); return false; }
}

function safeToolCatalog(configState = {}) {
  const enabled = configState?.tools?.enabled || {};
  const searchEnabled = configState?.webSearch?.enabled !== false;
  return {
    tools: ALL_TOOLS.map(tool => ({
      name: tool.name,
      description: String(tool.description || '').slice(0, 500),
      enabled: enabled[tool.name] !== false && (tool.name !== 'consultar_web' || searchEnabled),
      clientAllowed: isClientToolAllowed(tool.name)
    })),
    webSearch: {
      enabled: searchEnabled,
      provider: 'Google Search via Gemini',
      configured: Boolean(config.geminiKey),
      appliesTo: ['consultar_web', 'Google Search grounding do Gemini']
    }
  };
}

async function probeEvolution() {
  const checkedAt = new Date().toISOString();
  if (!config.evolutionUrl || !config.evolutionKey || !config.evolutionInstance) {
    return { configured: false, status: 'not_configured', checkedAt, instance: config.evolutionInstance || null, apiHost: safeHost(config.evolutionUrl), connected: false };
  }
  const start = Date.now();
  try {
    const response = await fetch(`${config.evolutionUrl}/instance/fetchInstances`, {
      headers: { apikey: config.evolutionKey },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      return { configured: true, status: 'unreachable', checkedAt, latencyMs: Date.now() - start, httpStatus: response.status, instance: config.evolutionInstance, apiHost: safeHost(config.evolutionUrl), connected: false };
    }
    const list = await response.json();
    const instance = Array.isArray(list) ? list.find(item => item?.name === config.evolutionInstance) : null;
    const connection = String(instance?.connectionStatus || instance?.state || 'unknown').toLowerCase();
    const connected = ['open', 'connected', 'online'].includes(connection);
    return {
      configured: true,
      status: instance ? (connected ? 'connected' : 'disconnected') : 'instance_not_found',
      checkedAt,
      latencyMs: Date.now() - start,
      instance: config.evolutionInstance,
      apiHost: safeHost(config.evolutionUrl),
      instanceState: connection,
      connected,
      ownerLinked: Boolean(instance?.ownerJid)
    };
  } catch (error) {
    return {
      configured: true,
      status: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable',
      checkedAt,
      latencyMs: Date.now() - start,
      instance: config.evolutionInstance,
      apiHost: safeHost(config.evolutionUrl),
      connected: false
    };
  }
}

function safeHost(value = '') {
  try { return new URL(value).host; } catch { return null; }
}

async function getIntegrations(webhookEventStore) {
  let webhookHistory = { configured: false, events: [] };
  try { webhookHistory = await webhookEventStore?.list(50) || webhookHistory; } catch { webhookHistory = { configured: false, events: [] }; }
  const circuitBreakers = getCircuitBreakers();
  const providers = Object.entries(circuitBreakers).map(([name, info]) => ({
    name,
    configured: Boolean(info.configured),
    state: info.status || 'unknown',
    failures: Number(info.failures || 0),
    quarantineSeconds: Number(info.quarantineSeconds || 0)
  }));
  const webhookCounts = (webhookHistory.events || []).reduce((counts, event) => {
    counts[event.status] = (counts[event.status] || 0) + 1;
    return counts;
  }, {});
  return {
    evolution: await probeEvolution(),
    supabase: { configured: Boolean(config.supabaseUrl && config.supabaseServiceRoleKey), urlHost: safeHost(config.supabaseUrl) },
    webhook: {
      authenticated: Boolean(config.webhookToken),
      route: '/webhook/evolution',
      ledgerConfigured: webhookHistory.configured,
      recentEvents: (webhookHistory.events || []).slice(0, 50),
      recentCounts: webhookCounts
    },
    providers,
    note: 'Credenciais e payloads de webhook não são expostos; o status da Evolution é uma verificação ao vivo.'
  };
}

export async function handleOperationsRoutes({ req, res, u, campaignStore, operationsStore, webhookEventStore, adminConfig, authContext = {} }) {
  const actorId = authContext.userId || null;
  const actorRole = authContext.role || 'viewer';

  if (req.method === 'GET' && u.pathname === '/api/dashboard/session') return json(res, 200, { userId: actorId, role: actorRole });

  if (req.method === 'GET' && u.pathname === '/api/dashboard/tools') {
    const active = safeToolCatalog(adminConfig?.active || {});
    const draft = actorRole === 'admin' ? safeToolCatalog(adminConfig?.draft || {}) : null;
    return json(res, 200, { ...active, active, draft, revision: adminConfig?.revision || 0, persistence: adminConfig?.persistence || 'fallback' });
  }
  if (req.method === 'PATCH' && u.pathname === '/api/dashboard/tools') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const existing = adminConfig?.draft || {};
    const knownNames = new Set(ALL_TOOLS.map(tool => tool.name));
    const toggles = body?.enabled;
    if (!toggles || typeof toggles !== 'object' || Array.isArray(toggles) || Object.entries(toggles).some(([name, enabled]) => !knownNames.has(name) || typeof enabled !== 'boolean') || (body.webSearchEnabled !== undefined && typeof body.webSearchEnabled !== 'boolean')) {
      return json(res, 400, { error: 'invalid_tool_settings' });
    }
    const result = await adminConfig.updateDraft({
      tools: { enabled: { ...(existing.tools?.enabled || {}), ...toggles } },
      ...(body.webSearchEnabled === undefined ? {} : { webSearch: { enabled: body.webSearchEnabled } })
    }, `user:${actorId || 'admin'}`);
    if (!result.ok) return json(res, 400, result);
    const auditLogged = await auditBestEffort(operationsStore, { actorId, action: 'tool_settings_draft_updated', entityType: 'bot_config', metadata: { source: 'dashboard', status: 'draft' } });
    return json(res, 200, { ok: true, active: safeToolCatalog(result.snapshot.active), draft: safeToolCatalog(result.snapshot.draft), revision: result.snapshot.revision, auditLogged });
  }

  if (req.method === 'GET' && u.pathname === '/api/dashboard/operations') {
    try {
      const campaigns = campaignStore ? await campaignStore.listSummaries() : [];
      const suppressions = campaignStore ? await campaignStore.listSuppressions(100) : [];
      return json(res, 200, {
        ok: true,
        configured: Boolean(campaignStore?.enabled),
        campaigns: campaigns || [],
        suppressions: (suppressions || []).map(item => ({ phone: maskPhone(item.phone), reason: item.reason, source: item.source, suppressedAt: item.suppressed_at, createdAt: item.created_at })),
        queue: { campaigns: campaigns?.length || 0 }
      });
    } catch (error) {
      return json(res, errorStatus(error), { ok: false, error: error?.code || 'operations_unavailable' });
    }
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/campaigns') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    try {
      const campaign = await campaignStore.create({ ...body, actorId, idempotencyKey: req.headers['idempotency-key'] || body.idempotencyKey });
      const auditLogged = await auditBestEffort(operationsStore, { actorId, action: 'campaign_created', entityType: 'campaign', entityId: campaign.id, metadata: { recipientCount: campaign.total_recipients } });
      return json(res, 201, { ok: true, campaign: publicCampaign(campaign), auditLogged });
    } catch (error) {
      return json(res, errorStatus(error), { ok: false, error: error?.code || 'campaign_request_failed' });
    }
  }
  const campaignMatch = u.pathname.match(/^\/api\/dashboard\/campaigns\/([0-9a-f-]{36})(?:\/(execute|pause|cancel))?$/i);
  if (campaignMatch) {
    const [, id, action] = campaignMatch;
    if (!isUuid(id)) return json(res, 400, { ok: false, error: 'invalid_campaign_id' });
    try {
      if (req.method === 'GET' && !action) {
        const campaign = await campaignStore.get(id);
        return campaign ? json(res, 200, { ok: true, campaign: publicCampaign(campaign) }) : json(res, 404, { ok: false, error: 'campaign_not_found' });
      }
      if (req.method === 'POST' && action === 'execute') {
        let body;
        try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
        if (body.confirm !== true) return json(res, 400, { ok: false, error: 'explicit_confirmation_required' });
        const campaign = await campaignStore.execute(id);
        const auditLogged = await auditBestEffort(operationsStore, { actorId, action: 'campaign_execution_requested', entityType: 'campaign', entityId: id, metadata: { recipientCount: campaign?.total_recipients || 0 } });
        return campaign ? json(res, 200, { ok: true, campaign: publicCampaign(campaign), auditLogged }) : json(res, 404, { ok: false, error: 'campaign_not_found' });
      }
      if (req.method === 'POST' && ['pause', 'cancel'].includes(action)) {
        const campaign = await campaignStore.transition(id, action === 'pause' ? 'paused' : 'cancelled');
        const auditLogged = await auditBestEffort(operationsStore, { actorId, action: action === 'pause' ? 'campaign_paused' : 'campaign_cancelled', entityType: 'campaign', entityId: id, metadata: { status: action === 'pause' ? 'paused' : 'cancelled' } });
        return campaign ? json(res, 200, { ok: true, campaign: publicCampaign(campaign), auditLogged }) : json(res, 404, { ok: false, error: 'campaign_not_found' });
      }
      return json(res, 405, { ok: false, error: 'method_not_allowed' });
    } catch (error) {
      return json(res, errorStatus(error), { ok: false, error: error?.code || 'campaign_request_failed' });
    }
  }
  if (req.method === 'POST' && u.pathname === '/api/dashboard/suppressions') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    try {
      const item = await campaignStore.addSuppression({ phone: body.phone, reason: body.reason, source: 'dashboard' });
      const auditLogged = await auditBestEffort(operationsStore, { actorId, action: 'phone_suppression_added', entityType: 'phone_suppression', metadata: { source: 'dashboard', reasonCode: 'opt_out' } });
      return json(res, 201, { ok: true, suppression: { phone: maskPhone(item.phone), reason: item.reason, source: item.source, suppressedAt: item.suppressed_at }, auditLogged });
    } catch (error) {
      return json(res, errorStatus(error), { ok: false, error: error?.code || 'suppression_request_failed' });
    }
  }
  if (req.method === 'DELETE' && u.pathname === '/api/dashboard/suppressions') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    if (body.confirm !== true) return json(res, 400, { ok: false, error: 'explicit_confirmation_required' });
    try {
      await campaignStore.removeSuppression(body.phone);
      const auditLogged = await auditBestEffort(operationsStore, { actorId, action: 'phone_suppression_removed', entityType: 'phone_suppression', metadata: { source: 'dashboard', reasonCode: 'manual_removal' } });
      return json(res, 200, { ok: true, auditLogged });
    } catch (error) {
      return json(res, errorStatus(error), { ok: false, error: error?.code || 'suppression_request_failed' });
    }
  }

  if (req.method === 'GET' && u.pathname === '/api/dashboard/users') {
    try { return json(res, 200, { ok: true, users: await operationsStore.listUsers() }); }
    catch (error) { return json(res, errorStatus(error), { ok: false, error: error?.code || 'user_management_unavailable' }); }
  }
  const userMatch = u.pathname.match(/^\/api\/dashboard\/users\/([0-9a-f-]{36})$/i);
  if (userMatch && req.method === 'PATCH') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    try {
      const profile = await operationsStore.updateProfile({ id: userMatch[1], actorId, role: body.role, active: body.active, fullName: body.fullName });
      const auditLogged = await auditBestEffort(operationsStore, { actorId, action: 'user_profile_updated', entityType: 'profile', entityId: userMatch[1], metadata: { role: body.role, active: body.active } });
      return json(res, 200, { ok: true, profile: { id: profile.id, fullName: profile.full_name || '', role: profile.role, active: profile.active }, auditLogged });
    } catch (error) { return json(res, errorStatus(error), { ok: false, error: error?.code || 'profile_update_failed' }); }
  }
  if (req.method === 'GET' && u.pathname === '/api/dashboard/audit') {
    try { return json(res, 200, { ok: true, entries: await operationsStore.listAudit(100) }); }
    catch (error) { return json(res, errorStatus(error), { ok: false, error: error?.code || 'audit_unavailable' }); }
  }

  if (req.method === 'GET' && u.pathname === '/api/dashboard/integrations') {
    return json(res, 200, await getIntegrations(webhookEventStore));
  }

  return NOT_HANDLED;
}

export { publicCampaign };
