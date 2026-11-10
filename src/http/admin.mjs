import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { json, readBody, NOT_HANDLED } from './utils.mjs';
import { config } from '../config.mjs';
import { SessionStore } from '../sessions.mjs';
import { createFlow } from '../flow.mjs';
import { askAI } from '../ai.mjs';
import { validPhone } from '../dashboard.mjs';

// Rotas /api/admin/config/*.
export async function handleAdminRoutes({ req, res, u, adminConfig, faqFor }) {
  if (req.method === 'GET' && u.pathname === '/api/admin/config') return json(res, 200, { ...adminConfig.snapshot(), persistence: adminConfig.persistence || 'fallback', persistenceError: adminConfig.remoteError || null });
  if (req.method === 'PATCH' && u.pathname === '/api/admin/config/draft') { const body = await readBody(req); const result = adminConfig.updateDraft(body.patch || body, 'dashboard'); return json(res, result.ok ? 200 : 400, result); }
  if (req.method === 'POST' && u.pathname === '/api/admin/config/validate') { const result = adminConfig.updateDraft(adminConfig.draft, 'validator'); return json(res, result.ok ? 200 : 400, { ok: result.ok, errors: result.errors || [] }); }
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
  if (req.method === 'POST' && u.pathname === '/api/admin/config/rollback') { const body = await readBody(req); const result = await adminConfig.rollback(body.revision, 'dashboard'); return json(res, result.ok ? 200 : 400, result); }
  return NOT_HANDLED;
}
