import { config } from '../config.mjs';
import { serveStatic } from '../dashboard.mjs';
import { json, NOT_HANDLED } from './utils.mjs';
import { isChatwootApiPath, isVerifiedWebhookEndpoint, isLegacyStaticPath } from './proxy.mjs';
import { handleDashboardRoutes, handleDashboardSettingsRoutes, handleDashboardRuntimeRoutes } from './dashboard.mjs';
import { handleAdminRoutes } from './admin.mjs';
import { handleBridgeRoutes } from './bridge-routes.mjs';
import { renderPixPaymentPage } from './pix-page.mjs';
import { handleOperationsRoutes } from './operations.mjs';
import { handleWebhookRoutes } from './webhook.mjs';
import { checkReadiness } from './readiness.mjs';

// Monta o handler de requests do createApp. A ponte de máquina continua independente
// do guard humano do dashboard; rotas administrativas usam papéis Supabase explícitos.
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };
function requiredRole(pathname, method) {
  if (pathname.startsWith('/api/admin/') || pathname === '/api/dashboard/users' || pathname.startsWith('/api/dashboard/users/') || pathname === '/api/dashboard/audit') return 'admin';
  if (method === 'POST' && /^\/api\/dashboard\/campaigns\/[0-9a-f-]{36}\/execute$/i.test(pathname)) return 'admin';
  if (pathname === '/api/dashboard/suppressions' && method === 'DELETE') return 'admin';
  if (pathname === '/api/dashboard/tools' && method !== 'GET') return 'admin';
  if (pathname === '/api/dashboard/metrics/reset') return 'admin';
  if (['/api/dashboard/state', '/api/dashboard/send', '/api/dashboard/simulate', '/api/dashboard/mode', '/api/dashboard/clear', '/api/dashboard/operations', '/api/dashboard/tts'].includes(pathname)) return 'operator';
  if (pathname.startsWith('/api/dashboard/campaigns') || pathname.startsWith('/api/dashboard/suppressions')) return 'operator';
  if (pathname === '/api/dashboard/ping-ai') return 'operator';
  return 'viewer';
}

export function createRouter({ store, f, adminConfig, auth, webhookAuthorize, runtimeAI, faqFor, rateMessage, schedule, getHumanPhone, getCachedInstanceOwner, updateInstanceOwner, proxyToChatwoot, readinessCheck = checkReadiness, campaignStore, operationsStore, webhookEventStore, aiBudgetGate, sectorProjection }) {
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
    if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && u.pathname === '/ready') {
      const readiness = await readinessCheck();
      return json(res, readiness.ok ? 200 : 503, readiness);
    }
    if (req.method === 'GET' && u.pathname === '/pix') {
      return renderPixPaymentPage(res, u);
    }
    if (isChatwootApiPath(u.pathname)) {
      // Esses endpoints validam assinatura, segredo ou verify token no Chatwoot upstream.
      if (isVerifiedWebhookEndpoint(req.method, u.pathname)) return proxyToChatwoot(req, res);
      const authResult = await auth(req, config);
      const authorizedRequest = typeof authResult === 'object' ? authResult.ok === true : authResult === true;
      if (!authorizedRequest) return json(res, typeof authResult === 'object' ? authResult.status || 401 : 401, { error: 'dashboard_auth_required' });
      const role = typeof authResult === 'object' ? authResult.role : 'admin';
      if (!(ROLE_RANK[role] >= ROLE_RANK.operator)) return json(res, 403, { error: 'dashboard_role_not_authorized' });
      return proxyToChatwoot(req, res);
    }
    if (u.pathname === '/api/dashboard/auth/config') return json(res, 200, { supabaseUrl: config.supabaseUrl, publishableKey: config.supabaseKey, captchaSiteKey: config.supabaseCaptchaSiteKey, captchaProvider: config.supabaseCaptchaProvider, allowUnauthenticated: false });
    let authContext = null;
    if (u.pathname.startsWith('/api/dashboard/') || u.pathname.startsWith('/api/admin/')) {
      const authResult = await auth(req, config);
      const authorizedRequest = typeof authResult === 'object' ? authResult.ok === true : authResult === true;
      if (!authorizedRequest) {
        const status = typeof authResult === 'object' ? authResult.status || 401 : 401;
        const reason = typeof authResult === 'object' ? authResult.reason || 'dashboard_auth_required' : 'dashboard_auth_required';
        return json(res, status, { error: status === 403 ? 'dashboard_profile_not_authorized' : status === 503 ? 'dashboard_auth_unavailable' : 'dashboard_auth_required', reason });
      }
      authContext = typeof authResult === 'object' ? authResult : { ok: true, role: 'admin' };
      const minimumRole = requiredRole(u.pathname, req.method);
      if (!(ROLE_RANK[authContext.role] >= ROLE_RANK[minimumRole])) return json(res, 403, { error: 'dashboard_role_not_authorized', requiredRole: minimumRole });
      req.dashboardAuth = authContext;
    }
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
    const bridgeResult = await handleBridgeRoutes({ req, res, u, store, f, webhookAuthorize, campaignStore, adminConfig, sectorProjection });
    if (bridgeResult !== NOT_HANDLED) return bridgeResult;
    const settingsResult = await handleDashboardSettingsRoutes({ req, res, u, store, runtimeAI });
    if (settingsResult !== NOT_HANDLED) return settingsResult;
    const adminResult = await handleAdminRoutes({ req, res, u, adminConfig, faqFor });
    if (adminResult !== NOT_HANDLED) return adminResult;
    const operationsResult = await handleOperationsRoutes({ req, res, u, campaignStore, operationsStore, webhookEventStore, adminConfig, authContext: req.dashboardAuth || {}, sectorProjection });
    if (operationsResult !== NOT_HANDLED) return operationsResult;
    const runtimeResult = await handleDashboardRuntimeRoutes({ req, res, u, store, runtimeAI, readinessCheck, campaignStore, adminConfig, operationsStore, aiBudgetGate });
    if (runtimeResult !== NOT_HANDLED) return runtimeResult;
    const webhookResult = await handleWebhookRoutes({ req, res, u, store, f, adminConfig, webhookAuthorize, schedule, getHumanPhone, getCachedInstanceOwner, updateInstanceOwner, rateMessage, webhookEventStore });
    if (webhookResult !== NOT_HANDLED) return webhookResult;
    return json(res, 404, { error: 'not_found' });
  };
}
