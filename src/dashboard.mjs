import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
export function validPhone(p){ const s = String(p||'').replace(/^sim:/, ''); return /^\d{8,15}$/.test(s) || /^\d+@lid$/i.test(s); }

export function authCache() {
  const cache = new Map();

  return async (req, config) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return { ok: false, status: 401, reason: 'missing_token' };

    // Server-to-server callers use the configured webhook secret. This bypass
    // is deliberately independent of Supabase and never applies to other tokens.
    const webhookToken = String(config.webhookToken || '');
    const provided = Buffer.from(token);
    const expected = Buffer.from(webhookToken);
    if (expected.length > 0 && provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
      return { ok: true };
    }

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
        cache.set(key, { result, until: Date.now() + 15000 });
        return result;
      }

      const user = await response.json();
      if (!user?.id) {
        const result = { ok: false, status: 401, reason: 'invalid_token' };
        cache.set(key, { result, until: Date.now() + 15000 });
        return result;
      }

      const profileUrl = new URL(`${config.supabaseUrl}/rest/v1/profiles`);
      profileUrl.searchParams.set('select', 'active,role');
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
      const allowed = Boolean(profile?.active === true && (!config.dashboardRoles.length || config.dashboardRoles.includes(profile.role)));
      const result = allowed
        ? { ok: true }
        : { ok: false, status: 403, reason: profile ? 'profile_inactive_or_role_not_allowed' : 'profile_not_found' };
      cache.set(key, { result, until: Date.now() + 60000 });
      return result;
    } catch {
      const result = { ok: false, status: 503, reason: 'auth_provider_unavailable' };
      cache.set(key, { result, until: Date.now() + 5000 });
      return result;
    }
  };
}
export async function serveStatic(req,res,config){const p=new URL(req.url,'http://localhost').pathname;const rel=p==='/'||p==='/dashboard'||p==='/dashboard/'?'index.html':p.replace(/^\/dashboard\//,'').replace(/^\//,'');const allowed=new Set(['index.html','app.js','styles.css']);if(!allowed.has(rel)&&!rel.startsWith('vendor/')){res.writeHead(404);return res.end();}const root=path.resolve(config.publicDir),file=path.resolve(root,rel);if(!file.startsWith(`${root}${path.sep}`))return res.end();try{const body=await fs.readFile(file);res.writeHead(200,{'content-type':rel.endsWith('.js')?'text/javascript; charset=utf-8':rel.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self' https://challenges.cloudflare.com https://js.hcaptcha.com https://hcaptcha.com; frame-src https://challenges.cloudflare.com https://*.hcaptcha.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.supabase.co https://challenges.cloudflare.com https://*.hcaptcha.com"});res.end(body);}catch{res.writeHead(404);res.end();}}
