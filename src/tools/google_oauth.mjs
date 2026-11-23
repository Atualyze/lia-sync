import crypto from 'node:crypto';
import { config } from '../config.mjs';
import { resolveGoogleAccessToken } from './google_auth.mjs';
import { createGoogleHttp } from './google_http.mjs';

export const GOOGLE_OAUTH_SCOPE_CATALOG = Object.freeze({
  calendar: {
    id: 'calendar',
    label: 'Google Agenda (Calendar)',
    description: 'Consultar horários livres, sugerir janelas e criar/listar eventos',
    scopes: ['https://www.googleapis.com/auth/calendar']
  },
  drive: {
    id: 'drive',
    label: 'Google Drive (Arquivos)',
    description: 'Listar, buscar e enviar PDFs/arquivos do Drive no WhatsApp',
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  },
  docs: {
    id: 'docs',
    label: 'Google Docs (Ler & Editar)',
    description: 'Ler documentos e anexar/substituir texto (edição exclusiva do dono)',
    scopes: ['https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive.file']
  },
  sheets: {
    id: 'sheets',
    label: 'Google Planilhas (Sheets)',
    description: 'Consultar, buscar linhas e adicionar registros em planilhas',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  },
  gmail: {
    id: 'gmail',
    label: 'Gmail (Leitura + Rascunhos)',
    description: 'Buscar/ler e-mails e criar rascunhos seguros (nunca envia nem apaga)',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose']
  }
});

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 50;
const pendingStates = new Map();

function pruneExpiredStates(nowMs = Date.now()) {
  for (const [key, entry] of pendingStates.entries()) {
    if (nowMs - entry.createdAt > STATE_TTL_MS) pendingStates.delete(key);
  }
  while (pendingStates.size > MAX_PENDING_STATES) {
    const oldest = pendingStates.keys().next().value;
    if (!oldest) break;
    pendingStates.delete(oldest);
  }
}

export function resolveSelectedGoogleScopes(selectedIds = []) {
  const validIds = (Array.isArray(selectedIds) ? selectedIds : [])
    .map(id => String(id || '').trim().toLowerCase())
    .filter(id => Object.prototype.hasOwnProperty.call(GOOGLE_OAUTH_SCOPE_CATALOG, id));
  const uniqueIds = [...new Set(validIds.length ? validIds : ['calendar', 'drive', 'sheets'])];
  const scopeSet = new Set(['openid', 'email']);
  for (const id of uniqueIds) {
    for (const s of GOOGLE_OAUTH_SCOPE_CATALOG[id].scopes) scopeSet.add(s);
  }
  return { selectedIds: uniqueIds, scopes: [...scopeSet] };
}

export function buildGoogleOAuthStart({
  selectedIds = ['calendar', 'drive', 'sheets'],
  redirectUri,
  clientId = config.googleClientId || process.env.GOOGLE_CLIENT_ID || '',
  clientSecret = config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || '',
  nowMs = Date.now()
} = {}) {
  const cleanClientId = String(clientId || '').trim();
  const cleanSecret = String(clientSecret || '').trim();
  if (!cleanClientId || !cleanSecret) {
    throw new Error('google_oauth_client_not_configured');
  }
  const cleanRedirect = String(redirectUri || '').trim();
  if (!/^https?:\/\/[^/\s]+/i.test(cleanRedirect)) {
    throw new Error('invalid_redirect_uri');
  }

  pruneExpiredStates(nowMs);
  const { selectedIds: ids, scopes } = resolveSelectedGoogleScopes(selectedIds);
  const state = crypto.randomBytes(24).toString('base64url');
  pendingStates.set(state, {
    redirectUri: cleanRedirect,
    selectedIds: ids,
    scopes,
    createdAt: nowMs
  });

  const params = new URLSearchParams({
    client_id: cleanClientId,
    redirect_uri: cleanRedirect,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });

  return {
    state,
    selectedIds: ids,
    scopes,
    redirectUri: cleanRedirect,
    authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  };
}

export function consumeGoogleOAuthState(state, nowMs = Date.now()) {
  pruneExpiredStates(nowMs);
  const key = String(state || '').trim();
  if (!key || !pendingStates.has(key)) return null;
  const entry = pendingStates.get(key);
  pendingStates.delete(key);
  if (nowMs - entry.createdAt > STATE_TTL_MS) return null;
  return entry;
}

export async function exchangeGoogleOAuthCode({
  code,
  redirectUri,
  clientId = config.googleClientId || process.env.GOOGLE_CLIENT_ID || '',
  clientSecret = config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || '',
  fetchImpl = globalThis.fetch
} = {}) {
  const cleanCode = String(code || '').trim();
  if (!cleanCode) throw new Error('missing_oauth_code');
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      code: cleanCode,
      client_id: String(clientId || '').trim(),
      client_secret: String(clientSecret || '').trim(),
      redirect_uri: String(redirectUri || '').trim(),
      grant_type: 'authorization_code'
    }).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error_description || data?.error || `google_token_exchange_http_${res.status}`);
  }
  let email = '';
  if (data.access_token) {
    try {
      const infoRes = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { authorization: `Bearer ${data.access_token}` },
        signal: AbortSignal.timeout(8_000)
      });
      if (infoRes.ok) {
        const info = await infoRes.json().catch(() => ({}));
        email = String(info?.email || '').trim();
      }
    } catch {}
  }
  return {
    accessToken: data.access_token || '',
    refreshToken: data.refresh_token || '',
    scope: String(data.scope || ''),
    email
  };
}

/**
 * Busca recursos reais da conta Google conectada (agendas, pastas do Drive e planilhas)
 * para preencher os seletores visuais do painel sem o usuário precisar copiar IDs manualmente.
 */
export async function fetchGoogleWorkspaceResources({ fetchImpl = globalThis.fetch, botConfig = {} } = {}) {
  const token = await resolveGoogleAccessToken({
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly'
    ]
  });
  if (!token) {
    return { connected: false, calendars: [], folders: [], spreadsheets: [] };
  }
  const http = createGoogleHttp({ accessToken: token, fetchImpl, timeoutMs: 12_000 });
  const [calRes, folderRes, sheetRes] = await Promise.allSettled([
    http.send({
      method: 'GET',
      host: 'www.googleapis.com',
      path: '/calendar/v3/users/me/calendarList',
      query: { maxResults: 30 }
    }),
    http.send({
      method: 'GET',
      host: 'www.googleapis.com',
      path: '/drive/v3/files',
      query: {
        q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        pageSize: 30,
        orderBy: 'modifiedTime desc',
        fields: 'files(id,name)'
      }
    }),
    http.send({
      method: 'GET',
      host: 'www.googleapis.com',
      path: '/drive/v3/files',
      query: {
        q: "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
        pageSize: 30,
        orderBy: 'modifiedTime desc',
        fields: 'files(id,name)'
      }
    })
  ]);

  const calendars = calRes.status === 'fulfilled' && Array.isArray(calRes.value?.items)
    ? calRes.value.items.map(c => ({ id: c.id, name: c.summary || c.id, primary: Boolean(c.primary) }))
    : [];
  const folders = folderRes.status === 'fulfilled' && Array.isArray(folderRes.value?.files)
    ? folderRes.value.files.map(f => ({ id: f.id, name: f.name || f.id }))
    : [];
  const spreadsheets = sheetRes.status === 'fulfilled' && Array.isArray(sheetRes.value?.files)
    ? sheetRes.value.files.map(f => ({ id: f.id, name: f.name || f.id }))
    : [];

  return {
    connected: true,
    calendars,
    folders,
    spreadsheets,
    selected: {
      googleCalendarId: botConfig?.tools?.settings?.gerenciar_agenda_google?.calendarId || botConfig?.integrations?.googleCalendar?.calendarId || '',
      googleDriveFolderId: botConfig?.tools?.settings?.gerenciar_drive_google?.defaultFolderId || '',
      googleSheetsDefaultId: botConfig?.tools?.settings?.consultar_planilha_google?.defaultSpreadsheetId || ''
    }
  };
}
