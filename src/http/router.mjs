import { config } from '../config.mjs';
import { serveStatic } from '../dashboard.mjs';
import { json, NOT_HANDLED } from './utils.mjs';
import { isChatwootApiPath, isVerifiedWebhookEndpoint, isLegacyStaticPath, isDashboardViewPath } from './proxy.mjs';
import { handleDashboardRoutes, handleDashboardSettingsRoutes, handleDashboardRuntimeRoutes } from './dashboard.mjs';
import { handleAgendaRoutes } from './agenda-routes.mjs';
import { handleRuntimeDashboardRoutes } from './runtime-routes.mjs';
import { handleAdminRoutes } from './admin.mjs';
import { handleBridgeRoutes } from './bridge-routes.mjs';
import { isIssuedPixLink, renderPixPaymentPage } from './pix-page.mjs';
import { clientKeyFor, createPublicRateLimiter } from './public-rate-limit.mjs';
import { handleInfinitePayWebhookRoute, resolveInfinitePayWebhookSecret } from './infinitepay-webhook.mjs';
import { consumeGoogleOAuthState, exchangeGoogleOAuthCode } from '../tools/google_oauth.mjs';
import { clearGoogleTokenCache } from '../tools/google_auth.mjs';
import { handleOperationsRoutes } from './operations.mjs';
import { handleProspectingRoutes } from './prospecting-routes.mjs';
import { handleWebhookRoutes } from './webhook.mjs';
import { checkReadiness } from './readiness.mjs';
import { createApiV1Handler } from './api-v1.mjs';
import { renderPayHomePage } from './pay-home.mjs';
import { infinitePayOrders } from '../tools/gerenciar_cobranca_pagamento.mjs';

// Monta o handler de requests do createApp. A ponte de máquina continua independente
// do guard humano do dashboard; rotas administrativas usam papéis Supabase explícitos.
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };

// Matriz explícita de papel mínimo por rota do painel.
// A primeira regra que casar vence; regras são avaliadas na ordem declarada,
// então padrões específicos (ex.: campaigns/:id/execute) vêm antes dos prefixos.
// `path` casa exato, `prefix` casa o segmento e seus filhos, `pattern` casa regex.
const DASHBOARD_ROLE_RULES = Object.freeze([
  // Leitura de contexto próprio e catálogos públicos do painel.
  { method: 'GET', path: '/api/dashboard/session', role: 'viewer' },
  { method: 'GET', path: '/api/dashboard/config', role: 'viewer' },
  { method: 'GET', path: '/api/dashboard/models', role: 'viewer' },
  { method: 'GET', path: '/api/dashboard/agent-structure', role: 'viewer' },
  { method: 'GET', path: '/api/dashboard/voice-status', role: 'viewer' },
  { method: 'GET', path: '/api/dashboard/health-summary', role: 'viewer' },
  { method: 'GET', path: '/api/dashboard/integrations', role: 'viewer' },
  { method: 'GET', path: '/api/dashboard/tools', role: 'viewer' },
  // Leitura operacional sensível: exige operator.
  { method: 'GET', path: '/api/dashboard/state', role: 'operator' },
  { method: 'GET', path: '/api/dashboard/metrics', role: 'operator' },
  { method: 'GET', path: '/api/dashboard/operations', role: 'operator' },
  { method: 'GET', path: '/api/dashboard/runtime/overview', role: 'operator' },
  { method: 'GET', path: '/api/dashboard/runtime/uncertain-tasks', role: 'admin' },
  { method: 'POST', pattern: /^\/api\/dashboard\/runtime\/tasks\/[0-9a-f-]{36}\/reconcile$/i, role: 'admin' },
  { method: 'GET', path: '/api/dashboard/whatsapp/baileys', role: 'operator' },
  { method: 'GET', prefix: '/api/dashboard/prospecting', role: 'operator' },
  { method: 'GET', path: '/api/dashboard/avatar', role: 'operator' },
  // Administração: usuários, auditoria, inventário do host e reset de métricas.
  { prefix: '/api/dashboard/users', role: 'admin' },
  { path: '/api/dashboard/audit', role: 'admin' },
  { method: 'GET', path: '/api/dashboard/vps-monitor', role: 'admin' },
  { method: 'POST', path: '/api/dashboard/metrics/reset', role: 'admin' },
  { method: 'PATCH', path: '/api/dashboard/tools', role: 'admin' },
  { method: 'DELETE', path: '/api/dashboard/suppressions', role: 'admin' },
  { method: 'POST', pattern: /^\/api\/dashboard\/campaigns\/[0-9a-f-]{36}\/execute$/i, role: 'admin' },
  { prefix: '/api/dashboard/prospecting', role: 'admin' },
  // Escrita operacional do atendimento: exige operator.
  { method: 'POST', path: '/api/dashboard/simulate', role: 'operator' },
  { method: 'POST', path: '/api/dashboard/send', role: 'operator' },
  { method: 'POST', path: '/api/dashboard/mode', role: 'operator' },
  { method: 'POST', path: '/api/dashboard/finish', role: 'operator' },
  { method: 'POST', path: '/api/dashboard/clear', role: 'operator' },
  { method: 'POST', path: '/api/dashboard/tts', role: 'operator' },
  { method: 'POST', path: '/api/dashboard/ping-ai', role: 'operator' },
  { method: 'POST', path: '/api/dashboard/suppressions', role: 'operator' },
  { prefix: '/api/dashboard/campaigns', role: 'operator' }
]);

function matchesRule(rule, pathname, method) {
  if (rule.method && rule.method !== method) return false;
  if (rule.pattern) return rule.pattern.test(pathname);
  if (rule.path) return rule.path === pathname;
  if (rule.prefix) return pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`);
  return false;
}

// Rota não declarada na matriz falha fechada em `admin`, nunca em `viewer`.
export function requiredRole(pathname, method) {
  if (pathname.startsWith('/api/admin/')) return 'admin';
  if (!pathname.startsWith('/api/dashboard/')) return 'viewer';
  const rule = DASHBOARD_ROLE_RULES.find(candidate => matchesRule(candidate, pathname, method));
  return rule ? rule.role : 'admin';
}

export function createRouter({ store, f, adminConfig, auth, webhookAuthorize, runtimeAI, faqFor, rateMessage, schedule, getHumanPhone, getCachedInstanceOwner, updateInstanceOwner, proxyToChatwoot, readinessCheck = checkReadiness, campaignStore, operationsStore, webhookEventStore, aiBudgetGate, sectorProjection, tenantStore = null, customSectorStore = null, prospecting = null, askAI = null, integrationsStore = null, liaRuntime = null, liaLearning = null, liaAutonomy = null, apiSettingsStore = null, customProviderStore = null, baileysProvider = null, copilotTaskStore = null, agendaStore = null, reminderStore = null, onAIConfigUpdated = null, deliverReactivationReply = null, getActiveInstancePhone = null, notifyCopilot = null, apiV1 = createApiV1Handler({ integrationsStore }) }) {
  const publicPayRateLimit = createPublicRateLimiter({ limitPerMin: Number(process.env.PAY_PUBLIC_RATE_LIMIT_PER_MIN) || undefined });
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
    const requestHost = String(req.headers.host || '').replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
    const pixToolSettings = adminConfig?.active?.tools?.settings?.gerenciar_cobranca_pagamento || {};
    const paymentPageEnabled = pixToolSettings.enablePaymentPage !== false;
    const payHomeEnabled = pixToolSettings.enablePayHome !== false && paymentPageEnabled;
    const renderPaymentPageDisabled = () => {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Página indisponível</title></head><body style="font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px"><div style="max-width:420px;text-align:center"><h2 style="margin:0 0 8px">Página de pagamento temporariamente desativada</h2><p style="color:#cbd5e1">Solicite a chave Pix ou QR Code diretamente pelo nosso WhatsApp.</p></div></body></html>');
    };
    const payHost = (() => { try { return new URL(pixToolSettings.paymentBaseUrl || '').host.replace(/:\d+$/, '').toLowerCase(); } catch { return ''; } })() || 'pay.atualyze.com.br';
    const isPayRoute = req.method === 'GET' && (u.pathname === '/pix' || /^\/p\/[A-Za-z0-9_-]{16}$/.test(u.pathname) || (u.pathname === '/' && requestHost === payHost));
    if (isPayRoute) {
      const limit = publicPayRateLimit(clientKeyFor(req));
      if (!limit.allowed) {
        res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(limit.retryAfterSec), 'cache-control': 'no-store' });
        return res.end('Muitas requisições. Tente novamente em instantes.');
      }
    }
    const renderPixLinkUnavailable = () => {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Pix indisponível</title></head><body style="margin:0;min-height:100dvh;display:grid;place-items:center;background:#07131a;color:#f5fbff;font:500 16px system-ui,sans-serif"><main style="max-width:420px;padding:28px;text-align:center"><h1>Link Pix indisponível</h1><p>Este link não existe ou não está mais disponível. Solicite uma nova cobrança pelo WhatsApp.</p></main></body></html>');
    };
    const dashboardHost = (() => { try { return new URL(config.dashboardOrigin || '').host.replace(/:\d+$/, '').toLowerCase(); } catch { return ''; } })();
    if (req.method === 'GET' && u.pathname === '/' && dashboardHost && requestHost === dashboardHost) {
      res.writeHead(302, { location: '/dashboard', 'cache-control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && u.pathname === '/' && requestHost === payHost) {
      if (!payHomeEnabled) return renderPaymentPageDisabled();
      return renderPayHomePage(res);
    }
    const shortPixMatch = u.pathname.match(/^\/p\/([A-Za-z0-9_-]{16})$/);
    if (req.method === 'GET' && shortPixMatch) {
      if (!paymentPageEnabled) return renderPaymentPageDisabled();
      const paymentOrderStore = store?.paymentOrderStore || infinitePayOrders;
      const order = await paymentOrderStore.findByShortCode(shortPixMatch[1]);
      let paymentPageUrl = null;
      try {
        const candidate = new URL(order?.paymentUrl || '');
        if (candidate.protocol === 'https:' && candidate.pathname === '/pix' && candidate.searchParams.has('p')) {
          paymentPageUrl = candidate;
        }
      } catch {
        // Código inexistente, cobrança antiga ou URL armazenada inválida.
      }
      if (!paymentPageUrl) return renderPixLinkUnavailable();
      return renderPixPaymentPage(res, paymentPageUrl);
    }
    if (req.method === 'GET' && u.pathname === '/pix') {
      if (!paymentPageEnabled) return renderPaymentPageDisabled();
      const issuedOrderStore = store?.paymentOrderStore || infinitePayOrders;
      if (!(await isIssuedPixLink(u, issuedOrderStore))) return renderPixLinkUnavailable();
      return renderPixPaymentPage(res, u);
    }
    const paymentSettings = adminConfig?.active?.tools?.settings?.gerenciar_cobranca_pagamento || {};
    const infinitePayResult = await handleInfinitePayWebhookRoute({
      req,
      res,
      u,
      store,
      orderStore: store?.paymentOrderStore,
      getHumanPhone,
      webhookSecret: resolveInfinitePayWebhookSecret(paymentSettings)
    });
    if (infinitePayResult !== NOT_HANDLED) return infinitePayResult;
    if (req.method === 'GET' && u.pathname === '/api/oauth/google/callback') {
      const renderOAuthHtml = (ok, title, subtitle, payload = {}) => {
        const safePayload = JSON.stringify({ type: ok ? 'lia-google-oauth-success' : 'lia-google-oauth-error', ...payload }).replace(/</g, '\\u003c');
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}.card{max-width:440px;background:#1e293b;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:24px;text-align:center}h2{margin:0 0 8px}p{color:#cbd5e1;font-size:14px;line-height:1.5}</style></head><body><div class="card"><h2>${title}</h2><p>${subtitle}</p></div><script>try{if(window.opener){window.opener.postMessage(${safePayload}, window.location.origin);}}catch(e){}setTimeout(function(){try{window.close();}catch(e){}}, ${ok ? 1800 : 6000});</script></body></html>`);
      };
      const oauthError = u.searchParams.get('error');
      if (oauthError) {
        return renderOAuthHtml(false, 'Conexão cancelada', `O Google retornou: ${String(oauthError).replace(/[<>&"]/g, '')}.`, { error: oauthError });
      }
      const stateEntry = consumeGoogleOAuthState(u.searchParams.get('state') || '');
      if (!stateEntry) {
        return renderOAuthHtml(false, 'Sessão OAuth expirada', 'Inicie novamente clicando em "Conectar com Google" no painel da Lia Sync.', { error: 'invalid_state' });
      }
      const code = u.searchParams.get('code') || '';
      try {
        const tokens = await exchangeGoogleOAuthCode({ code, redirectUri: stateEntry.redirectUri });
        if (!tokens.refreshToken) {
          return renderOAuthHtml(false, 'Refresh Token não retornado', 'Remova o acesso anterior do app na sua Conta Google (Segurança → Apps de terceiros) e conecte novamente para gerar o token offline.', { error: 'missing_refresh_token' });
        }
        if (apiSettingsStore) {
          await apiSettingsStore.update({ googleRefreshToken: tokens.refreshToken });
        } else {
          config.googleRefreshToken = tokens.refreshToken;
        }
        clearGoogleTokenCache();
        return renderOAuthHtml(true, '✅ Google Workspace Conectado!', `Conta conectada${tokens.email ? ` (${tokens.email})` : ''}. Permissões aplicadas em tempo real na Lia! Esta janela fechará automaticamente.`, { email: tokens.email || '', selectedIds: stateEntry.selectedIds });
      } catch (err) {
        return renderOAuthHtml(false, 'Falha na conexão com o Google', String(err?.message || 'Erro ao trocar código OAuth.').replace(/[<>&"]/g, ''), { error: err?.message || 'oauth_exchange_failed' });
      }
    }
    if (isChatwootApiPath(u.pathname)) {
      // Esses endpoints validam assinatura, segredo ou verify token no Chatwoot upstream.
      if (isVerifiedWebhookEndpoint(req.method, u.pathname)) return proxyToChatwoot(req, res);
      const authResult = await auth(req, config);
      const authorizedRequest = authResult && typeof authResult === 'object' ? authResult.ok === true : authResult === true;
      if (!authorizedRequest) return json(res, authResult && typeof authResult === 'object' ? authResult.status || 401 : 401, { error: 'dashboard_auth_required' });
      const role = authResult && typeof authResult === 'object' ? authResult.role : 'admin';
      if (!(ROLE_RANK[role] >= ROLE_RANK.operator)) return json(res, 403, { error: 'dashboard_role_not_authorized' });
      return proxyToChatwoot(req, res);
    }
    if (u.pathname === '/api/dashboard/auth/config') return json(res, 200, { supabaseUrl: config.supabaseUrl, publishableKey: config.supabaseKey, captchaSiteKey: config.supabaseCaptchaSiteKey, captchaProvider: config.supabaseCaptchaProvider, allowUnauthenticated: false });
    let authContext;
    if (u.pathname.startsWith('/api/dashboard/') || u.pathname.startsWith('/api/admin/')) {
      const authResult = await auth(req, config);
      const authorizedRequest = authResult && typeof authResult === 'object' ? authResult.ok === true : authResult === true;
      if (!authorizedRequest) {
        const status = authResult && typeof authResult === 'object' ? authResult.status || 401 : 401;
        const reason = authResult && typeof authResult === 'object' ? authResult.reason || 'dashboard_auth_required' : 'dashboard_auth_required';
        return json(res, status, { error: status === 403 ? 'dashboard_profile_not_authorized' : status === 503 ? 'dashboard_auth_unavailable' : 'dashboard_auth_required', reason });
      }
      authContext = authResult && typeof authResult === 'object' ? authResult : { ok: true, role: 'admin' };
      const minimumRole = requiredRole(u.pathname, req.method);
      if (!(ROLE_RANK[authContext.role] >= ROLE_RANK[minimumRole])) return json(res, 403, { error: 'dashboard_role_not_authorized', requiredRole: minimumRole });
      req.dashboardAuth = authContext;
    }
    if (req.method === 'GET' && !u.pathname.startsWith('/api/')) {
      if (isLegacyStaticPath(u.pathname)) {
        if (u.pathname === '/legacy-dashboard' || isDashboardViewPath(u.pathname)) req.url = '/index.html';
        return serveStatic(req, res, config);
      }
      const authResult = await auth(req, config);
      const authorizedRequest = authResult && typeof authResult === 'object' ? authResult.ok === true : authResult === true;
      if (!authorizedRequest) return json(res, authResult && typeof authResult === 'object' ? authResult.status || 401 : 401, { error: 'dashboard_auth_required' });
      return proxyToChatwoot(req, res, () => serveStatic(req, res, config));
    }
    const dashboardResult = await handleDashboardRoutes({ req, res, u, store, f, deliverReactivationReply, getActiveInstancePhone, notifyCopilot });
    if (dashboardResult !== NOT_HANDLED) return dashboardResult;
    const agendaResult = await handleAgendaRoutes({ req, res, u, store, adminConfig, agendaStore, reminderStore, liaRuntime });
    if (agendaResult !== false) return agendaResult;
    const bridgeResult = await handleBridgeRoutes({ req, res, u, store, f, webhookAuthorize, campaignStore, adminConfig, sectorProjection, webhookEventStore, deliverReactivationReply });
    if (bridgeResult !== NOT_HANDLED) return bridgeResult;
    const settingsResult = await handleDashboardSettingsRoutes({ req, res, u, store, runtimeAI, adminConfig, tenantStore, customSectorStore, f, deliverReactivationReply, getActiveInstancePhone });
    if (settingsResult !== NOT_HANDLED) return settingsResult;
    const adminResult = await handleAdminRoutes({ req, res, u, adminConfig, faqFor, integrationsStore, onAIConfigUpdated });
    if (adminResult !== NOT_HANDLED) return adminResult;
    const operationsResult = await handleOperationsRoutes({ req, res, u, campaignStore, operationsStore, webhookEventStore, adminConfig, authContext: req.dashboardAuth || {}, sectorProjection });
    if (operationsResult !== NOT_HANDLED) return operationsResult;
    const prospectingResult = await handleProspectingRoutes({ req, res, u, prospecting });
    if (prospectingResult !== NOT_HANDLED) return prospectingResult;
    const runtimeResult = await handleDashboardRuntimeRoutes({ req, res, u, store, runtimeAI, readinessCheck, campaignStore, adminConfig, operationsStore, aiBudgetGate });
    if (runtimeResult !== NOT_HANDLED) return runtimeResult;
    const liaEngineResult = await handleRuntimeDashboardRoutes({ req, res, u, authContext: req.dashboardAuth || {}, liaRuntime, liaLearning, liaAutonomy, apiSettingsStore, customProviderStore, baileysProvider, operationsStore, copilotTaskStore, onAIConfigUpdated, adminConfig });
    if (liaEngineResult !== NOT_HANDLED) return liaEngineResult;
    const webhookResult = await handleWebhookRoutes({ req, res, u, store, f, adminConfig, webhookAuthorize, schedule, getHumanPhone, getCachedInstanceOwner, updateInstanceOwner, rateMessage, webhookEventStore, campaignStore, prospecting });
    if (webhookResult !== NOT_HANDLED) return webhookResult;
    const apiV1Result = await apiV1({ req, res, u, store, adminConfig, runtimeAI, readinessCheck, askAI });
    if (apiV1Result !== NOT_HANDLED) return apiV1Result;
    return json(res, 404, { error: 'not_found' });
  };
}
