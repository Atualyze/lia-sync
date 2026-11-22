import { json, readBody, NOT_HANDLED } from './utils.mjs';
import { getCircuitBreakers } from '../ai/config.mjs';
import { opened, failures } from '../ai/state.mjs';
import { clearGoogleTokenCache } from '../tools/google_auth.mjs';
import { memoryStore, PARA_CATEGORIES } from '../core/memory.mjs';
import { config } from '../config.mjs';

/**
 * Rotas autenticadas do painel para controle total do Motor v3.0
 * (Lia Runtime, Learning Engine, Autonomy Engine, Provedores de IA customizados, Baileys Nativo e API Settings hot-reload).
 *
 * Controle de papel aplicado em src/http/router.mjs:
 * - GET /api/dashboard/runtime/overview: operator+
 * - GET /api/dashboard/whatsapp/baileys: operator+
 * - Demais rotas (políticas, objetivos, compromissos, propostas, wake, api-settings, ai-providers, whatsapp/baileys/*): admin
 */
export async function handleRuntimeDashboardRoutes({
  req,
  res,
  u,
  authContext,
  liaRuntime,
  liaLearning,
  liaAutonomy,
  apiSettingsStore,
  customProviderStore,
  baileysProvider,
  operationsStore,
  onAIConfigUpdated = null
}) {
  const pathname = u.pathname;
  const isRuntimePath = pathname.startsWith('/api/dashboard/runtime');
  const isApiSettingsPath = pathname === '/api/dashboard/api-settings';
  const isAiProvidersPath = pathname === '/api/dashboard/ai-providers' || pathname.startsWith('/api/dashboard/ai-providers/');
  const isBaileysPath = pathname === '/api/dashboard/whatsapp/baileys' || pathname.startsWith('/api/dashboard/whatsapp/baileys/');
  const isMemoriesPath = pathname === '/api/dashboard/memories' || pathname.startsWith('/api/dashboard/memories/');
  if (!isRuntimePath && !isApiSettingsPath && !isAiProvidersPath && !isBaileysPath && !isMemoriesPath) return NOT_HANDLED;

  // === 0.00 Memória Estruturada PARA (Projetos, Áreas, Recursos, Arquivo) ===
  if (isMemoriesPath) {
    if (req.method === 'GET' && pathname === '/api/dashboard/memories') {
      const category = u.searchParams.get('category') || '';
      const search = u.searchParams.get('search') || '';
      const scopeKey = u.searchParams.get('scopeKey') || '';
      const result = memoryStore.listAll({ category, search, scopeKey, limit: 150 });
      return json(res, 200, { categories: PARA_CATEGORIES, ...result });
    }
    if (req.method === 'POST' && pathname === '/api/dashboard/memories') {
      let body;
      try { body = await readBody(req); }
      catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
      const content = String(body?.content || '').trim();
      const scopeKey = String(body?.scopeKey || 'default:business').trim();
      const type = String(body?.type || 'fact').trim();
      const saved = memoryStore.remember({ scopeKey, type, content, importance: 0.85, confidence: 0.95, source: 'dashboard_para' });
      if (!saved?.saved) {
        return json(res, 400, { error: saved?.reason || 'memory_save_failed' });
      }
      if (body?.category && saved.memory?.id) {
        memoryStore.updateById(saved.memory.id, { category: body.category });
      }
      return json(res, 201, { ok: true, memory: memoryStore.items.get(saved.memory.id) || saved.memory });
    }
    const memMatch = pathname.match(/^\/api\/dashboard\/memories\/([^/]+)$/);
    if (memMatch) {
      const id = decodeURIComponent(memMatch[1]);
      if (req.method === 'PATCH') {
        let body;
        try { body = await readBody(req); }
        catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
        const resUpdate = memoryStore.updateById(id, {
          content: body?.content,
          category: body?.category,
          type: body?.type
        });
        if (!resUpdate.updated) {
          return json(res, resUpdate.reason === 'not_found' ? 404 : 400, { error: resUpdate.reason || 'memory_update_failed' });
        }
        return json(res, 200, { ok: true, memory: resUpdate.memory });
      }
      if (req.method === 'DELETE') {
        const resDel = memoryStore.deleteById(id);
        if (!resDel.deleted) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 405, { error: 'method_not_allowed' });
  }

  // === 0.0 Gestão do Motor WhatsApp Baileys Nativo (QR Code, Pairing Code, Desconectar) ===
  if (isBaileysPath) {
    if (!baileysProvider) return json(res, 503, { error: 'baileys_provider_unavailable' });
    if (req.method === 'GET' && pathname === '/api/dashboard/whatsapp/baileys') {
      return json(res, 200, {
        activeEngine: config.whatsappProvider || 'evolution',
        ...baileysProvider.getStatus()
      });
    }
    if (req.method === 'POST' && pathname === '/api/dashboard/whatsapp/baileys/connect') {
      try {
        if (apiSettingsStore && config.whatsappProvider !== 'baileys') {
          await apiSettingsStore.update({ whatsappProvider: 'baileys' });
        } else {
          config.whatsappProvider = 'baileys';
        }
        const status = await baileysProvider.start();
        await operationsStore?.recordAudit?.({
          actor: authContext?.email || authContext?.userId || 'admin',
          action: 'baileys_connect_requested',
          metadata: { status: status.status }
        }).catch(() => {});
        return json(res, 200, { ok: true, activeEngine: config.whatsappProvider, ...status });
      } catch (error) {
        return json(res, 500, { error: error?.message || 'baileys_start_failed' });
      }
    }
    if (req.method === 'POST' && pathname === '/api/dashboard/whatsapp/baileys/pair') {
      let body;
      try { body = await readBody(req); }
      catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
      try {
        if (apiSettingsStore && config.whatsappProvider !== 'baileys') {
          await apiSettingsStore.update({ whatsappProvider: 'baileys' });
        } else {
          config.whatsappProvider = 'baileys';
        }
        const code = await baileysProvider.requestPairingCode(body?.phone || '');
        return json(res, 200, { ok: true, pairingCode: code, ...baileysProvider.getStatus() });
      } catch (error) {
        return json(res, 400, { error: error?.message || 'baileys_pairing_failed' });
      }
    }
    if (req.method === 'POST' && pathname === '/api/dashboard/whatsapp/baileys/disconnect') {
      let body = {};
      try { body = await readBody(req); } catch {}
      const logout = body?.logout !== false;
      const status = await baileysProvider.stop({ logout });
      await operationsStore?.recordAudit?.({
        actor: authContext?.email || authContext?.userId || 'admin',
        action: 'baileys_disconnected',
        metadata: { logout }
      }).catch(() => {});
      return json(res, 200, { ok: true, activeEngine: config.whatsappProvider, ...status });
    }
    if (req.method === 'POST' && pathname === '/api/dashboard/whatsapp/baileys/engine') {
      let body;
      try { body = await readBody(req); }
      catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
      const engine = String(body?.engine || '').toLowerCase() === 'baileys' ? 'baileys' : 'evolution';
      if (apiSettingsStore) {
        await apiSettingsStore.update({ whatsappProvider: engine });
      } else {
        config.whatsappProvider = engine;
      }
      if (engine === 'baileys' && baileysProvider.status === 'disconnected') {
        void baileysProvider.start().catch(() => {});
      }
      return json(res, 200, { ok: true, activeEngine: config.whatsappProvider, ...baileysProvider.getStatus() });
    }
    return json(res, 405, { error: 'method_not_allowed' });
  }

  // === 0. Cadastro e Gestão de Provedores de IA Customizados (OpenAI-compatible) ===
  if (isAiProvidersPath) {
    if (!customProviderStore) return json(res, 503, { error: 'custom_providers_unavailable' });
    if (req.method === 'GET' && pathname === '/api/dashboard/ai-providers') {
      return json(res, 200, {
        mode: customProviderStore.mode,
        customProviders: customProviderStore.listSafe(),
        circuitBreakers: getCircuitBreakers(),
        apiSettings: apiSettingsStore ? apiSettingsStore.getSafeView().items.filter(i => i.group === 'ai') : []
      });
    }
    if ((req.method === 'POST' || req.method === 'PUT') && pathname === '/api/dashboard/ai-providers') {
      let body;
      try { body = await readBody(req); }
      catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
      try {
        const saved = await customProviderStore.upsert(body);
        opened.delete(saved.id);
        failures.delete(saved.id);
        await operationsStore?.recordAudit?.({
          actor: authContext?.email || authContext?.userId || 'admin',
          action: 'custom_ai_provider_saved',
          metadata: { provider: saved.id, model: saved.defaultModel }
        }).catch(() => {});
        onAIConfigUpdated?.('custom_provider_saved');
        return json(res, 200, { ok: true, provider: saved, circuitBreakers: getCircuitBreakers() });
      } catch (error) {
        return json(res, 400, { error: error.message || 'invalid_custom_provider' });
      }
    }
    const provMatch = pathname.match(/^\/api\/dashboard\/ai-providers\/([a-z][a-z0-9_-]{1,31})$/i);
    if (provMatch && req.method === 'DELETE') {
      const removed = await customProviderStore.remove(provMatch[1]);
      if (!removed) return json(res, 404, { error: 'provider_not_found' });
      await operationsStore?.recordAudit?.({
        actor: authContext?.email || authContext?.userId || 'admin',
        action: 'custom_ai_provider_removed',
        metadata: { provider: provMatch[1] }
      }).catch(() => {});
      return json(res, 200, { ok: true, circuitBreakers: getCircuitBreakers() });
    }
    return json(res, 405, { error: 'method_not_allowed' });
  }

  // === 1. Configuração de APIs & Provedores (Hot-Reload sem entrar na VPS) ===
  if (isApiSettingsPath) {
    if (!apiSettingsStore) return json(res, 503, { error: 'api_settings_unavailable' });
    if (req.method === 'GET') {
      return json(res, 200, apiSettingsStore.getSafeView());
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      let body;
      try { body = await readBody(req); }
      catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
      try {
        const result = await apiSettingsStore.update(body);
        opened.clear();
        failures.clear();
        clearGoogleTokenCache();
        await operationsStore?.recordAudit?.({
          actor: authContext?.email || authContext?.userId || 'admin',
          action: 'api_settings_updated',
          metadata: { changedKeys: result.changedKeys }
        }).catch(() => {});
        onAIConfigUpdated?.('api_settings_updated');
        return json(res, 200, { ok: true, changedKeys: result.changedKeys, settings: result.view });
      } catch (error) {
        return json(res, 400, { error: error.message || 'invalid_api_settings' });
      }
    }
    return json(res, 405, { error: 'method_not_allowed' });
  }

  // === 2. Visão Geral Consolidada do Motor (Runtime + Learning + Autonomy) ===
  if (req.method === 'GET' && pathname === '/api/dashboard/runtime/overview') {
    const tenantId = u.searchParams.get('tenant') || 'default';
    const [identity, goals, commitments, knowledge, strategies, proposals, recentDecisions] = await Promise.all([
      liaRuntime?.available ? liaRuntime.identity.get().catch(() => null) : null,
      liaRuntime?.available ? liaRuntime.goals.list().catch(() => []) : [],
      liaRuntime?.available ? liaRuntime.commitments.list().catch(() => []) : [],
      liaLearning?.available ? liaLearning.knowledge.list().catch(() => []) : [],
      liaLearning?.available ? liaLearning.strategies.list().catch(() => []) : [],
      liaLearning?.available ? liaLearning.listProposals().catch(() => []) : [],
      liaAutonomy?.listPersistedDecisions ? liaAutonomy.listPersistedDecisions({ tenantId, limit: 25 }).catch(() => []) : (liaAutonomy?.getAuditTrail?.({ tenantId, limit: 25 }) || [])
    ]);

    return json(res, 200, {
      readiness: {
        runtime: liaRuntime?.readiness?.() || { status: 'unavailable' },
        learning: liaLearning?.readiness?.() || { status: 'unavailable' },
        autonomy: liaAutonomy?.readiness?.() || { status: 'unavailable' }
      },
      identity,
      presence: liaAutonomy?.presence?.snapshot?.() || null,
      policy: liaAutonomy?.getPolicy?.(tenantId) || null,
      budget: liaAutonomy?.getBudget?.(tenantId)?.snapshot?.() || null,
      metrics: liaAutonomy?.getMetrics?.() || null,
      goals,
      commitments,
      knowledge: knowledge.slice(0, 50),
      strategies: strategies.slice(0, 50),
      proposals: proposals.slice(0, 50),
      decisions: recentDecisions
    });
  }

  // === 3. Acordar Runtime manualmente ===
  if (req.method === 'POST' && pathname === '/api/dashboard/runtime/wake') {
    if (!liaRuntime?.available) return json(res, 503, { error: 'lia_runtime_unavailable' });
    const summary = await liaRuntime.wake({ reason: 'dashboard_manual' });
    return json(res, 200, { ok: Boolean(summary?.ok), summary });
  }

  // === 4. Atualizar Política de Autonomia (persistida no Supabase) ===
  if ((req.method === 'PUT' || req.method === 'PATCH') && pathname === '/api/dashboard/runtime/policy') {
    if (!liaAutonomy) return json(res, 503, { error: 'lia_autonomy_unavailable' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
    const tenantId = String(body?.tenant_id || 'default').trim() || 'default';
    const saved = await liaAutonomy.saveOrgPolicy(tenantId, body);
    await operationsStore?.recordAudit?.({
      actor: authContext?.email || authContext?.userId || 'admin',
      action: 'autonomy_policy_updated',
      metadata: { tenantId, autonomyLevel: saved.autonomy_level, allowedActions: saved.allowed_actions }
    }).catch(() => {});
    return json(res, 200, { ok: true, policy: saved });
  }

  // === 5. Objetivos (Goals): criar e atualizar ===
  if (req.method === 'POST' && pathname === '/api/dashboard/runtime/goals') {
    if (!liaRuntime?.available) return json(res, 503, { error: 'lia_runtime_unavailable' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
    try {
      const goal = await liaRuntime.goals.create(body);
      return json(res, 201, { ok: true, goal });
    } catch (error) {
      return json(res, 400, { error: error.message || 'invalid_goal' });
    }
  }

  const goalMatch = pathname.match(/^\/api\/dashboard\/runtime\/goals\/([0-9a-f-]{36})$/i);
  if (goalMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    if (!liaRuntime?.available) return json(res, 503, { error: 'lia_runtime_unavailable' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
    const id = goalMatch[1];
    const action = String(body?.action || '').trim();
    let updated;
    if (action === 'pause') updated = await liaRuntime.goals.pause(id);
    else if (action === 'resume') updated = await liaRuntime.goals.resume(id);
    else if (action === 'complete') updated = await liaRuntime.goals.complete(id);
    else if (action === 'cancel') updated = await liaRuntime.goals.cancel(id, body?.reason || '');
    else updated = await liaRuntime.goals.update(id, body);
    if (!updated) return json(res, 404, { error: 'goal_not_found' });
    return json(res, 200, { ok: true, goal: updated });
  }

  // === 6. Compromissos (Commitments): criar e atualizar ===
  if (req.method === 'POST' && pathname === '/api/dashboard/runtime/commitments') {
    if (!liaRuntime?.available) return json(res, 503, { error: 'lia_runtime_unavailable' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
    try {
      const commitment = await liaRuntime.commitments.create(body);
      return json(res, 201, { ok: true, commitment });
    } catch (error) {
      return json(res, 400, { error: error.message || 'invalid_commitment' });
    }
  }

  const commitmentMatch = pathname.match(/^\/api\/dashboard\/runtime\/commitments\/([0-9a-f-]{36})$/i);
  if (commitmentMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    if (!liaRuntime?.available) return json(res, 503, { error: 'lia_runtime_unavailable' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
    const id = commitmentMatch[1];
    const action = String(body?.action || '').trim();
    let updated;
    if (action === 'fulfill') updated = await liaRuntime.commitments.fulfill(id);
    else if (action === 'cancel') updated = await liaRuntime.commitments.cancel(id);
    else if (action === 'miss') updated = await liaRuntime.commitments.miss(id);
    else if (action === 'start') updated = await liaRuntime.commitments.start(id);
    else return json(res, 400, { error: 'invalid_commitment_action' });
    if (!updated) return json(res, 404, { error: 'commitment_not_found' });
    return json(res, 200, { ok: true, commitment: updated });
  }

  // === 7. Propostas de Melhoria (Improvement Proposals): aprovar/rejeitar ===
  const proposalMatch = pathname.match(/^\/api\/dashboard\/runtime\/proposals\/([0-9a-f-]{36})$/i);
  if (proposalMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    if (!liaLearning?.available) return json(res, 503, { error: 'lia_learning_unavailable' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
    const nextStatus = ['approved', 'rejected', 'implemented'].includes(body?.status) ? body.status : null;
    if (!nextStatus) return json(res, 400, { error: 'invalid_proposal_status' });
    const existing = await liaLearning.store.getFromCollection('proposals', 'lia_improvement_proposals', proposalMatch[1]);
    if (!existing) return json(res, 404, { error: 'proposal_not_found' });
    const updated = await liaLearning.store.upsertInCollection('proposals', 'lia_improvement_proposals', {
      ...existing,
      status: nextStatus,
      metadata: {
        ...(existing.metadata || {}),
        reviewed_by: authContext?.email || authContext?.userId || 'admin',
        reviewed_at: new Date().toISOString()
      }
    });
    return json(res, 200, { ok: true, proposal: updated });
  }

  return NOT_HANDLED;
}
