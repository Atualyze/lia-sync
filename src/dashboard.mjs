import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const PROFILE_ROLES = new Set(['admin', 'operator', 'viewer']);

export function validPhone(p) {
  const value = String(p || '').replace(/^sim:/, '');
  return /^\d{8,15}$/.test(value) || /^\d+@lid$/i.test(value);
}

export function isAiStudioPreview(req = null) {
  if (process.env.AI_STUDIO_PREVIEW === 'true' && process.env.NODE_ENV !== 'production') return true;
  const host = String(req?.headers?.host || '').split(':')[0].trim().toLowerCase();
  if (/^ais-dev-[a-z0-9-]+\.[a-z0-9-]+\.run\.app$/i.test(host)) return true;
  return false;
}

export function authCache() {
  const cache = new Map();

  return async (req, config) => {
    if (isAiStudioPreview(req)) {
      return {
        ok: true,
        role: 'admin',
        userId: 'ai-studio-preview',
        user: { id: 'ai-studio-preview', email: 'preview@aistudio.local', role: 'admin', active: true }
      };
    }
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return { ok: false, status: 401, reason: 'missing_token' };
    if (!config.supabaseUrl || !config.supabaseKey) return { ok: false, status: 503, reason: 'supabase_not_configured' };

    const key = crypto.createHash('sha256').update(token).digest('hex');
    const cached = cache.get(key);
    if (cached && cached.until > Date.now()) return cached.result;

    try {
      const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { apikey: config.supabaseKey, Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const result = { ok: false, status: 401, reason: 'invalid_token' };
        cache.set(key, { result, until: Date.now() + 10000 });
        return result;
      }
      const user = await response.json();
      if (!user?.id) {
        const result = { ok: false, status: 401, reason: 'invalid_token' };
        cache.set(key, { result, until: Date.now() + 10000 });
        return result;
      }

      const profileUrl = new URL(`${config.supabaseUrl}/rest/v1/profiles`);
      profileUrl.searchParams.set('select', 'id,active,role');
      profileUrl.searchParams.set('id', `eq.${user.id}`);
      const profileResponse = await fetch(profileUrl, {
        headers: { apikey: config.supabaseKey, Authorization: `Bearer ${token}` }
      });
      if (!profileResponse.ok) {
        const result = { ok: false, status: 503, reason: 'profile_lookup_failed' };
        cache.set(key, { result, until: Date.now() + 5000 });
        return result;
      }

      const profile = (await profileResponse.json())?.[0];
      const allowedByEnvironment = Array.isArray(config.dashboardRoles) && config.dashboardRoles.length
        ? config.dashboardRoles
        : [...PROFILE_ROLES];
      const allowed = Boolean(profile?.id === user.id && profile.active === true
        && PROFILE_ROLES.has(profile.role) && allowedByEnvironment.includes(profile.role));
      const result = allowed
        ? { ok: true, userId: user.id, role: profile.role }
        : { ok: false, status: 403, reason: profile ? 'profile_inactive_or_role_not_allowed' : 'profile_not_found' };
      cache.set(key, { result, until: Date.now() + 10000 });
      return result;
    } catch {
      const result = { ok: false, status: 503, reason: 'auth_provider_unavailable' };
      cache.set(key, { result, until: Date.now() + 5000 });
      return result;
    }
  };
}

export async function serveStatic(req, res, config) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const relative = pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/'
    ? 'index.html'
    : pathname.replace(/^\/dashboard\//, '').replace(/^\//, '');
  const allowed = new Set(['index.html', 'conectar.html', 'app.js', 'styles.css', 'logo.webp', 'logo.png', 'qrcode.png']);
  if (!allowed.has(relative) && !relative.startsWith('vendor/')) {
    res.writeHead(404);
    return res.end();
  }
  const root = path.resolve(config.publicDir);
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403);
    return res.end();
  }
  const contentType = relative.endsWith('.js')
    ? 'text/javascript; charset=utf-8'
    : relative.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : relative.endsWith('.webp')
        ? 'image/webp'
        : relative.endsWith('.png')
          ? 'image/png'
          : 'text/html; charset=utf-8';
  try {
    const isMutableAsset = relative.endsWith('.html') || relative.endsWith('.js') || relative.endsWith('.css');
    const stat = await fs.stat(file);
    const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    const allowAiStudioFrame = isAiStudioPreview(req);
    const commonHeaders = {
      'content-type': contentType,
      'cache-control': isMutableAsset ? 'no-cache, must-revalidate' : 'public, max-age=86400',
      'etag': etag,
      'x-content-type-options': 'nosniff',
      ...(allowAiStudioFrame ? {} : { 'x-frame-options': 'DENY' }),
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'self'; ${allowAiStudioFrame ? "frame-ancestors 'self' https://aistudio.google.com https://*.google.com https://*.googleusercontent.com" : "frame-ancestors 'none'"}; script-src 'self' https://challenges.cloudflare.com https://*.challenges.cloudflare.com https://js.hcaptcha.com https://hcaptcha.com; frame-src https://challenges.cloudflare.com https://*.challenges.cloudflare.com https://*.hcaptcha.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://challenges.cloudflare.com https://*.challenges.cloudflare.com; media-src 'self' data: blob:; connect-src 'self' data: https://*.supabase.co https://challenges.cloudflare.com https://*.challenges.cloudflare.com https://*.cloudflarecaptcha.com https://*.hcaptcha.com`
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, commonHeaders);
      res.end();
      return;
    }
    const body = await fs.readFile(file);
    res.writeHead(200, commonHeaders);
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}
