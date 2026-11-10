import { createRequire } from 'node:module';
import { config } from '../config.mjs';
import { faqAgeSeconds } from '../faq.mjs';
import { getCircuitBreakers } from '../ai.mjs';
import { serveStatic } from '../dashboard.mjs';
import { json, NOT_HANDLED } from './utils.mjs';
import { isChatwootApiPath, isVerifiedWebhookEndpoint, isLegacyStaticPath } from './proxy.mjs';
import { handleDashboardRoutes, handleDashboardSettingsRoutes, handleDashboardRuntimeRoutes } from './dashboard.mjs';
import { handleAdminRoutes } from './admin.mjs';
import { handleBridgeRoutes } from './bridge-routes.mjs';
import { handleWebhookRoutes } from './webhook.mjs';

const require = createRequire(import.meta.url);
const APP_VERSION = require('../../package.json').version;

// Monta o handler de requests do createApp. A ORDEM dos despachos abaixo é
// parte do contrato do servidor e deve permanecer idêntica.
export function createRouter({ store, f, adminConfig, auth, webhookAuthorize, runtimeAI, faqFor, rateMessage, schedule, getHumanPhone, getCachedInstanceOwner, updateInstanceOwner, proxyToChatwoot }) {
  return async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': config.dashboardOrigin || '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' }); return res.end(); }
    if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, service: 'lia-sync', version: APP_VERSION, uptime: Math.round(process.uptime()), providers: getCircuitBreakers(), activeProvider: runtimeAI().provider, activeModel: runtimeAI().model, faqAgeSeconds: faqAgeSeconds(), sessions: Object.keys(store.sessions).length, persistence: { runtimeEnabled: Boolean(store.client?.enabled), conversations: store.persistence || 'fallback', conversationsError: store.remoteError || null, config: adminConfig.persistence || 'fallback', configError: adminConfig.remoteError || null } });
    if (isChatwootApiPath(u.pathname)) {
      // Esses endpoints validam assinatura, segredo ou verify token no Chatwoot upstream.
      if (isVerifiedWebhookEndpoint(req.method, u.pathname)) return proxyToChatwoot(req, res);
      const authResult = await auth(req, config);
      const authorizedRequest = typeof authResult === 'object' ? authResult.ok === true : authResult === true;
      if (!authorizedRequest) return json(res, typeof authResult === 'object' ? authResult.status || 401 : 401, { error: 'dashboard_auth_required' });
      return proxyToChatwoot(req, res);
    }
    if (u.pathname === '/api/dashboard/auth/config') return json(res, 200, { supabaseUrl: config.supabaseUrl, publishableKey: config.supabaseKey, captchaSiteKey: config.supabaseCaptchaSiteKey, captchaProvider: config.supabaseCaptchaProvider, allowUnauthenticated: config.allowUnauthenticatedDashboard });
    if (u.pathname.startsWith('/api/dashboard/') || u.pathname.startsWith('/api/admin/')) { const authResult = await auth(req, config); const authorizedRequest = typeof authResult === 'object' ? authResult.ok === true : authResult === true; if (!authorizedRequest) { const status = typeof authResult === 'object' ? authResult.status || 401 : 401; const reason = typeof authResult === 'object' ? authResult.reason || 'dashboard_auth_required' : 'dashboard_auth_required'; return json(res, status, { error: status === 403 ? 'dashboard_profile_not_authorized' : status === 503 ? 'dashboard_auth_unavailable' : 'dashboard_auth_required', reason }); } }
    if (req.method === 'GET' && !u.pathname.startsWith('/api/')) {
      if (isLegacyStaticPath(u.pathname)) {
        if (u.pathname === '/legacy-dashboard') req.url = '/index.html';
        return serveStatic(req, res, config);
      }
      const authResult = await auth(req, config);
      const authorizedRequest = typeof authResult === 'object' ? authResult.ok === true : authResult === true;
      if (!authorizedRequest) return json(res, typeof authResult === 'object' ? authResult.status || 401 : 401, { error: 'dashboard_auth_required' });
      return proxyToChatwoot(req, res, () => serveStatic(req, res, config));
    }
    const dashboardResult = await handleDashboardRoutes({ req, res, u, store, f });
    if (dashboardResult !== NOT_HANDLED) return dashboardResult;
    const bridgeResult = await handleBridgeRoutes({ req, res, u, store, f, webhookAuthorize });
    if (bridgeResult !== NOT_HANDLED) return bridgeResult;
    const settingsResult = await handleDashboardSettingsRoutes({ req, res, u, store, runtimeAI });
    if (settingsResult !== NOT_HANDLED) return settingsResult;
    const adminResult = await handleAdminRoutes({ req, res, u, adminConfig, faqFor });
    if (adminResult !== NOT_HANDLED) return adminResult;
    const runtimeResult = await handleDashboardRuntimeRoutes({ req, res, u, store, runtimeAI });
    if (runtimeResult !== NOT_HANDLED) return runtimeResult;
    const webhookResult = await handleWebhookRoutes({ req, res, u, store, f, adminConfig, webhookAuthorize, schedule, getHumanPhone, getCachedInstanceOwner, updateInstanceOwner, rateMessage });
    if (webhookResult !== NOT_HANDLED) return webhookResult;
    return json(res, 404, { error: 'not_found' });
  };
}
