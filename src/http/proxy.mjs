import http from 'node:http';
import https from 'node:https';
import { withoutHopByHopHeaders, json } from './utils.mjs';

// Fábrica: recebe a URL interna do Chatwoot e devolve o proxy usado pelo createApp.
export function createChatwootProxy({ chatwootInternalUrl }) {
  return (req, res, fallback) => {
    let target;
    let incoming;
    try {
      target = new URL(chatwootInternalUrl);
      incoming = new URL(req.url, 'http://localhost');
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('invalid_chatwoot_target');
      if (incoming.pathname.length > 2048 || incoming.search.length > 2048 || /%(?:2f|5c|2e)/i.test(incoming.pathname) || /[\\\u0000-\u001f]/.test(incoming.pathname)) throw new Error('invalid_chatwoot_path');
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) throw new Error('invalid_chatwoot_method');
    } catch {
      if (fallback && !res.headersSent) return fallback();
      return json(res, 400, { error: 'invalid_chatwoot_request' });
    }
    const requestHeaders = withoutHopByHopHeaders(req.headers);
    requestHeaders.host = target.host;
    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request({
      hostname: target.hostname,
      port: target.port || undefined,
      path: incoming.pathname + incoming.search,
      method: req.method,
      headers: requestHeaders,
      timeout: 15000
    }, proxyRes => {
      res.writeHead(proxyRes.statusCode || 200, withoutHopByHopHeaders(proxyRes.headers));
      proxyRes.pipe(res, { end: true });
    });
    proxyReq.on('timeout', () => proxyReq.destroy(new Error('chatwoot_timeout')));
    proxyReq.on('error', err => {
      if (fallback && !res.headersSent) return fallback();
      console.error('[chatwoot-proxy]', err.message);
      if (!res.headersSent) json(res, 502, { error: 'chatwoot_unavailable' });
    });
    res.on('close', () => { if (!res.writableEnded) proxyReq.destroy(); });
    req.pipe(proxyReq, { end: true });
  };
}

export function isChatwootApiPath(pathname) {
  const roots = ['/api/events', '/api/status', '/api/conversations', '/api/contacts', '/api/knowledge-bases', '/api/triage', '/api/channels', '/api/lia', '/api/webhooks'];
  return roots.some(root => pathname === root || pathname.startsWith(`${root}/`));
}
export function isVerifiedWebhookEndpoint(method, pathname) {
  return ['GET', 'POST'].includes(method) && /^\/api\/webhooks\/(?:whatsapp|instagram|messenger|evolution|telegram)$/.test(pathname);
}
export function isLegacyStaticPath(pathname) {
  return (
    pathname === '/legacy-dashboard' ||
    pathname === '/dashboard' ||
    pathname === '/dashboard/' ||
    pathname === '/dashboard/index.html' ||
    pathname === '/dashboard/app.js' ||
    pathname === '/dashboard/styles.css' ||
    pathname === '/dashboard/logo.webp' ||
    pathname === '/dashboard/logo.png' ||
    pathname.startsWith('/dashboard/vendor/') ||
    pathname === '/conectar.html' ||
    pathname === '/qrcode.png' ||
    pathname === '/logo.webp' ||
    pathname === '/logo.png' ||
    pathname === '/app.js' ||
    pathname === '/styles.css' ||
    pathname.startsWith('/vendor/')
  );
}
