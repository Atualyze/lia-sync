import { config } from '../config.mjs';
import { serveStatic } from '../dashboard.mjs';
import { json, NOT_HANDLED } from './utils.mjs';
import { isChatwootApiPath, isVerifiedWebhookEndpoint, isLegacyStaticPath } from './proxy.mjs';
import { handleDashboardRoutes, handleDashboardSettingsRoutes, handleDashboardRuntimeRoutes } from './dashboard.mjs';
import { handleAdminRoutes } from './admin.mjs';
import { handleBridgeRoutes } from './bridge-routes.mjs';
import { handleWebhookRoutes } from './webhook.mjs';
import { checkReadiness } from './readiness.mjs';
import { getCircuitBreakers } from '../ai.mjs';
import packageJson from '../../package.json' with { type: 'json' };

// Monta o handler de requests do createApp. A ORDEM dos despachos abaixo é
// parte do contrato do servidor e deve permanecer idêntica.
export function createRouter({ store, f, adminConfig, auth, webhookAuthorize, runtimeAI, faqFor, rateMessage, schedule, getHumanPhone, getCachedInstanceOwner, updateInstanceOwner, proxyToChatwoot, readinessCheck = checkReadiness, campaignStore }) {
  return async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const requestOrigin = req.headers.origin;
    if (requestOrigin && config.dashboardOrigin && requestOrigin === config.dashboardOrigin && typeof res.setHeader === 'function') {
      res.setHeader('access-control-allow-origin', config.dashboardOrigin);
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!config.dashboardOrigin || requestOrigin !== config.dashboardOrigin) { res.writeHead(403, { vary: 'Origin' }); return res.end(); }
      res.writeHead(204, { 'access-control-allow-origin': config.dashboardOrigin, 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization', vary: 'Origin' });
      return res.end();
    }
    if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, version: packageJson.version, uptime: Math.round(process.uptime()), providers: getCircuitBreakers() });
    if (req.method === 'GET' && u.pathname === '/ready') {
      const readiness = await readinessCheck();
      return json(res, readiness.ok ? 200 : 503, readiness);
    }
    if (isChatwootApiPath(u.pathname)) {
      // Esses endpoints validam assinatura, segredo ou verify token no Chatwoot upstream.
      if (isVerifiedWebhookEndpoint(req.method, u.pathname)) return proxyToChatwoot(req, res);
      const authResult = await auth(req, config);
      const authorizedRequest = typeof authResult === 'object' ? authResult.ok === true : authResult === true;
      if (!authorizedRequest) return json(res, typeof authResult === 'object' ? authResult.status || 401 : 401, { error: 'dashboard_auth_required' });
      return proxyToChatwoot(req, res);
    }
    if (u.pathname === '/api/dashboard/auth/config') return json(res, 200, { supabaseUrl: config.supabaseUrl, publishableKey: config.supabaseKey, captchaSiteKey: config.supabaseCaptchaSiteKey, captchaProvider: config.supabaseCaptchaProvider, allowUnauthenticated: false });
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
    const bridgeResult = await handleBridgeRoutes({ req, res, u, store, f, webhookAuthorize, campaignStore });
    if (bridgeResult !== NOT_HANDLED) return bridgeResult;
    const settingsResult = await handleDashboardSettingsRoutes({ req, res, u, store, runtimeAI });
    if (settingsResult !== NOT_HANDLED) return settingsResult;
    const adminResult = await handleAdminRoutes({ req, res, u, adminConfig, faqFor });
    if (adminResult !== NOT_HANDLED) return adminResult;
    const runtimeResult = await handleDashboardRuntimeRoutes({ req, res, u, store, runtimeAI, readinessCheck, campaignStore, adminConfig });
    if (runtimeResult !== NOT_HANDLED) return runtimeResult;
    const webhookResult = await handleWebhookRoutes({ req, res, u, store, f, adminConfig, webhookAuthorize, schedule, getHumanPhone, getCachedInstanceOwner, updateInstanceOwner, rateMessage });
    if (webhookResult !== NOT_HANDLED) return webhookResult;
    return json(res, 404, { error: 'not_found' });
  };
}
