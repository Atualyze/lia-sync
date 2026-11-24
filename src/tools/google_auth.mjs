import crypto from 'node:crypto';
import { config } from '../config.mjs';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const tokenCache = new Map();


export function readGoogleCredentials(envPrefix = 'GOOGLE') {
  const prefixMap = {
    GOOGLE_CALENDAR: { accessToken: 'googleCalendarAccessToken', apiKey: 'googleCalendarApiKey' },
    GOOGLE_DRIVE: { accessToken: 'googleDriveAccessToken' },
    GOOGLE_SHEETS: { accessToken: 'googleSheetsAccessToken' },
    GOOGLE_GMAIL: { accessToken: 'googleGmailAccessToken' }
  };
  const mapped = prefixMap[envPrefix] || {};
  const legacy = (name, fallback = '') => process.env[`${envPrefix}_${name}`] || process.env[`GOOGLE_${name}`] || fallback;
  const rawPrivateKey = legacy('SERVICE_ACCOUNT_PRIVATE_KEY', config.googleServiceAccountPrivateKey);
  return {
    accessToken: mapped.accessToken ? (config[mapped.accessToken] || legacy('ACCESS_TOKEN')) : legacy('ACCESS_TOKEN'),
    apiKey: mapped.apiKey ? (config[mapped.apiKey] || legacy('API_KEY')) : legacy('API_KEY'),
    clientId: config.googleClientId || legacy('CLIENT_ID'),
    clientSecret: config.googleClientSecret || legacy('CLIENT_SECRET'),
    refreshToken: config.googleRefreshToken || legacy('REFRESH_TOKEN'),
    serviceAccountEmail: config.googleServiceAccountEmail || legacy('SERVICE_ACCOUNT_EMAIL'),
    serviceAccountPrivateKey: String(rawPrivateKey || '').replace(/\\n/g, '\n')
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
