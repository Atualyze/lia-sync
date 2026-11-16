import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { json, readBody, NOT_HANDLED } from './utils.mjs';
import { config } from '../config.mjs';
import { SessionStore } from '../sessions.mjs';
import { createFlow } from '../flow.mjs';
import { askAI } from '../ai.mjs';
import { validPhone } from '../dashboard.mjs';

// Rotas /api/admin/config/* e /api/admin/integrations/*.
export async function handleAdminRoutes({ req, res, u, adminConfig, faqFor, integrationsStore }) {
  if (req.method === 'GET' && u.pathname === '/api/admin/config') return json(res, 200, { ...adminConfig.snapshot(), persistence: adminConfig.persistence || 'fallback', persistenceError: adminConfig.remoteError || null });
  if (req.method === 'PATCH' && u.pathname === '/api/admin/config/draft') { const body = await readBody(req); const result = await adminConfig.updateDraft(body.patch || body, 'dashboard'); return json(res, result.ok ? 200 : 400, result); }
  if (req.method === 'POST' && u.pathname === '/api/admin/config/validate') { const result = await adminConfig.updateDraft(adminConfig.draft, 'validator'); return json(res, result.ok ? 200 : 400, { ok: result.ok, errors: result.errors || [] }); }
  if (req.method === 'POST' && u.pathname === '/api/admin/config/preview') {
    const body = await readBody(req);
    if (!validPhone(body.phone) || typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'phone_and_text_required' });
    const previewFile = path.join(os.tmpdir(), `lia-sync-preview-${process.pid}-${Date.now()}.json`);
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
  if (req.method === 'POST' && u.pathname === '/api/admin/config/discard') { const result = await adminConfig.discardDraft('dashboard'); return json(res, result.ok ? 200 : 400, result); }
  if (req.method === 'POST' && u.pathname === '/api/admin/config/rollback') { const body = await readBody(req); const result = await adminConfig.rollback(body.revision, 'dashboard'); return json(res, result.ok ? 200 : 400, result); }

  if (integrationsStore && u.pathname.startsWith('/api/admin/integrations/')) {
    if (req.method === 'GET' && u.pathname === '/api/admin/integrations/keys') {
      await integrationsStore.load();
      return json(res, 200, {
        ok: true,
        apiKeys: integrationsStore.listApiKeys(),
        webhooks: integrationsStore.listWebhooks()
      });
    }
    if (req.method === 'POST' && u.pathname === '/api/admin/integrations/keys') {
      try {
        const body = await readBody(req);
        const created = await integrationsStore.createApiKey({ name: body?.name, scopes: body?.scopes });
        return json(res, 201, { ok: true, ...created });
      } catch (err) {
        return json(res, 400, { ok: false, error: err?.message || 'invalid_key_payload' });
      }
    }
    const revokeMatch = u.pathname.match(/^\/api\/admin\/integrations\/keys\/([^/]+)$/);
    if (req.method === 'DELETE' && revokeMatch) {
      const revoked = await integrationsStore.revokeApiKey(decodeURIComponent(revokeMatch[1]));
      if (!revoked) return json(res, 404, { ok: false, error: 'api_key_not_found' });
      return json(res, 200, { ok: true, key: revoked });
    }
    if (req.method === 'POST' && u.pathname === '/api/admin/integrations/webhooks') {
      try {
        const body = await readBody(req);
        const created = await integrationsStore.createWebhook({ name: body?.name, url: body?.url, events: body?.events });
        return json(res, 201, { ok: true, ...created });
      } catch (err) {
        return json(res, 400, { ok: false, error: err?.message || 'invalid_webhook_payload' });
      }
    }
    const testHookMatch = u.pathname.match(/^\/api\/admin\/integrations\/webhooks\/([^/]+)\/test$/);
    if (req.method === 'POST' && testHookMatch) {
      const result = await integrationsStore.testWebhook(decodeURIComponent(testHookMatch[1]));
      if (!result) return json(res, 404, { ok: false, error: 'webhook_not_found' });
      return json(res, result.ok ? 200 : 502, result);
    }
    const hookMatch = u.pathname.match(/^\/api\/admin\/integrations\/webhooks\/([^/]+)$/);
    if (hookMatch) {
      const id = decodeURIComponent(hookMatch[1]);
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const updated = await integrationsStore.toggleWebhook(id, body?.enabled);
        if (!updated) return json(res, 404, { ok: false, error: 'webhook_not_found' });
        return json(res, 200, { ok: true, webhook: updated });
      }
      if (req.method === 'DELETE') {
        const deleted = await integrationsStore.deleteWebhook(id);
        if (!deleted) return json(res, 404, { ok: false, error: 'webhook_not_found' });
        return json(res, 200, { ok: true });
      }
    }
  }

  return NOT_HANDLED;
}
