import crypto from 'node:crypto';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const tokenCache = new Map();

export function readGoogleCredentials(envPrefix = 'GOOGLE') {
  const rawPrivateKey = process.env[`${envPrefix}_SERVICE_ACCOUNT_PRIVATE_KEY`] || process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
  return {
    accessToken: process.env[`${envPrefix}_ACCESS_TOKEN`] || process.env.GOOGLE_ACCESS_TOKEN || '',
    apiKey: process.env[`${envPrefix}_API_KEY`] || process.env.GOOGLE_API_KEY || '',
    clientId: process.env[`${envPrefix}_CLIENT_ID`] || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env[`${envPrefix}_CLIENT_SECRET`] || process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env[`${envPrefix}_REFRESH_TOKEN`] || process.env.GOOGLE_REFRESH_TOKEN || '',
    serviceAccountEmail: process.env[`${envPrefix}_SERVICE_ACCOUNT_EMAIL`] || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    serviceAccountPrivateKey: String(rawPrivateKey).replace(/\\n/g, '\n')
  };
}

export async function resolveGoogleAccessToken({
  scopes = ['https://www.googleapis.com/auth/calendar'],
  envPrefix = 'GOOGLE',
  credentials = null
} = {}) {
  const creds = credentials || readGoogleCredentials(envPrefix);
  if (creds.accessToken) return creds.accessToken;

  const scopeStr = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '');
  const cacheKey = `${envPrefix}:${creds.serviceAccountEmail || creds.clientId || 'default'}:${scopeStr}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  if (creds.clientId && creds.clientSecret && creds.refreshToken) {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: 'refresh_token'
      }).toString()
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.access_token) {
        tokenCache.set(cacheKey, {
          token: data.access_token,
          expiresAt: Date.now() + (Number(data.expires_in) || 3500) * 1000
        });
        return data.access_token;
      }
    }
  }

  if (creds.serviceAccountEmail && creds.serviceAccountPrivateKey) {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claim = Buffer.from(JSON.stringify({
      iss: creds.serviceAccountEmail,
      scope: scopeStr,
      aud: GOOGLE_TOKEN_URL,
      exp: nowSec + 3600,
      iat: nowSec
    })).toString('base64url');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${claim}`);
    const signature = signer.sign(creds.serviceAccountPrivateKey, 'base64url');
    const assertion = `${header}.${claim}.${signature}`;

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }).toString()
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.access_token) {
        tokenCache.set(cacheKey, {
          token: data.access_token,
          expiresAt: Date.now() + (Number(data.expires_in) || 3500) * 1000
        });
        return data.access_token;
      }
    }
  }

  return '';
}

export function clearGoogleTokenCache() {
  tokenCache.clear();
}
