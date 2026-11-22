export const GOOGLE_API_HOSTS = Object.freeze([
  'gmail.googleapis.com',
  'www.googleapis.com',
  'docs.googleapis.com',
  'slides.googleapis.com',
  'sheets.googleapis.com'
]);

export const GOOGLE_API_PATH_PREFIXES = Object.freeze({
  'gmail.googleapis.com': ['/gmail/v1/users/me/'],
  'www.googleapis.com': ['/calendar/v3/', '/drive/v3/', '/upload/drive/v3/'],
  'docs.googleapis.com': ['/v1/documents/'],
  'slides.googleapis.com': ['/v1/presentations/'],
  'sheets.googleapis.com': ['/v4/spreadsheets/']
});

export const DEFAULT_GOOGLE_TIMEOUT_MS = 20_000;
export const DEFAULT_GOOGLE_MAX_BYTES = 15 * 1024 * 1024;
const RETRYABLE_READ_STATUSES = new Set([502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 250;
export const UNCERTAIN_WRITE_WARNING = 'A alteração pode ou não ter sido aplicada no Google; confira antes de repetir.';

export class GoogleHttpError extends Error {
  constructor(code, message, { status = 0, uncertainWrite = false } = {}) {
    super(message);
    this.name = 'GoogleHttpError';
    this.code = code;
    this.status = status;
    this.uncertainWrite = uncertainWrite;
  }
}

export function isGoogleWriteRequest(request = {}) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'GET') return false;
  return !(method === 'POST' && request.readOnly === true);
}

export function buildGoogleApiUrl({ host, path, query } = {}) {
  if (!GOOGLE_API_HOSTS.includes(host)) {
    throw new GoogleHttpError('disallowed_host', `Host Google não permitido: ${host}`);
  }
  const rawPath = String(path || '');
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /(?:^|\/)\.\.(?:\/|$)|%2e%2e/i.test(rawPath)) {
    throw new GoogleHttpError('disallowed_path', 'Caminho de API Google inválido.');
  }
  const url = new URL(`https://${host}${rawPath}`);
  const prefixes = GOOGLE_API_PATH_PREFIXES[host] || [];
  if (!prefixes.some(prefix => url.pathname.startsWith(prefix))) {
    throw new GoogleHttpError('disallowed_path', `Prefixo de rota não permitido em ${host}.`);
  }
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function readBoundedResponse(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new GoogleHttpError('response_too_large', 'Resposta do Google excedeu o limite permitido.', { status: response.status });
  }
  const arrayBuf = await response.arrayBuffer();
  if (arrayBuf.byteLength > maxBytes) {
    throw new GoogleHttpError('response_too_large', 'Resposta do Google excedeu o limite permitido.', { status: response.status });
  }
  return Buffer.from(arrayBuf);
}

function mapGoogleApiError(status, payload, headers, writeFlag) {
  const rawMessage = String(payload?.error?.message || '').trim().slice(0, 300);
  const reasons = Array.isArray(payload?.error?.errors)
    ? payload.error.errors.map(item => String(item?.reason || ''))
    : [];
  const statusStr = String(payload?.error?.status || '');
  const wwwAuth = String(headers?.get?.('www-authenticate') || '');
  const withWarning = msg => (writeFlag ? `${msg} ${UNCERTAIN_WRITE_WARNING}` : msg);

  if (status >= 300 && status < 400) {
    return new GoogleHttpError('redirect_blocked', 'Redirecionamento inesperado bloqueado pela política de segurança.', { status, uncertainWrite: writeFlag });
  }
  if (status === 401) {
    return new GoogleHttpError('unauthenticated', 'Token Google expirado ou inválido. Reautentique a integração no painel.', { status });
  }
  if (status === 403) {
    if (
      reasons.some(r => /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(r))
      || /insufficient_scope/i.test(wwwAuth)
      || /insufficient.*scope|insufficient.*permission/i.test(rawMessage)
    ) {
      return new GoogleHttpError('insufficient_scope', 'A credencial Google conectada não tem permissão (escopo) para esta ação.', { status });
    }
    if (reasons.some(r => /accessNotConfigured|SERVICE_DISABLED/i.test(r)) || /not been used in project|is disabled/i.test(rawMessage)) {
      return new GoogleHttpError('api_disabled', 'A API correspondente não está habilitada no projeto Google Cloud.', { status });
    }
    return new GoogleHttpError('forbidden', rawMessage || 'Acesso negado pela API do Google.', { status });
  }
  if (status === 404) {
    return new GoogleHttpError('not_found', rawMessage || 'Recurso não encontrado no Google Workspace.', { status });
  }
  if (status === 429) {
    return new GoogleHttpError('rate_limited', 'Limite de requisições da API do Google atingido. Tente novamente em instantes.', { status });
  }
  if (status >= 500) {
    return new GoogleHttpError('google_server_error', withWarning(rawMessage || `Erro interno no Google (HTTP ${status}).`), { status, uncertainWrite: writeFlag });
  }
  return new GoogleHttpError(
    statusStr ? statusStr.toLowerCase() : 'google_api_error',
    withWarning(rawMessage || `Falha na requisição ao Google (HTTP ${status}).`),
    { status, uncertainWrite: writeFlag }
  );
}

/**
 * Cliente HTTP endurecido para APIs REST do Google Workspace.
 * - Allowlist estrita de hosts e prefixos
 * - Nunca segue redirects (redirect: 'manual')
 * - Retry automático APENAS em leituras (GET ou POST readOnly: true) em 502/503/504 ou falha de rede
 * - Nunca repete escritas (POST/PATCH/PUT/DELETE)
 */
export function createGoogleHttp({
  accessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_GOOGLE_TIMEOUT_MS,
  maxBytes = DEFAULT_GOOGLE_MAX_BYTES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS
} = {}) {
  const token = String(accessToken || '').trim();
  if (!token) {
    throw new GoogleHttpError('missing_token', 'Token de acesso Google ausente.');
  }

  async function requestRaw(req, { accept = 'application/json', responseType = 'json' } = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const writeFlag = isGoogleWriteRequest({ method, readOnly: req.readOnly });
    const url = buildGoogleApiUrl(req);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const mayRetry = !writeFlag && attempt === 0;
      const headers = {
        authorization: `Bearer ${token}`,
        accept,
        ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(req.headers || {})
      };

      let response;
      let buf;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual'
        });
        buf = await readBoundedResponse(response, maxBytes);
      } catch (error) {
        if (error instanceof GoogleHttpError) throw error;
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        if (mayRetry && !isTimeout) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          continue;
        }
        const msg = isTimeout
          ? 'Tempo esgotado ao aguardar resposta do Google.'
          : 'Falha de rede ao conectar à API do Google.';
        throw new GoogleHttpError(
          isTimeout ? 'timeout' : 'network',
          writeFlag ? `${msg} ${UNCERTAIN_WRITE_WARNING}` : msg,
          { uncertainWrite: writeFlag }
        );
      }

      if (response.status >= 300 && response.status < 400) {
        throw mapGoogleApiError(response.status, {}, response.headers, writeFlag);
      }

      if (!response.ok) {
        if (mayRetry && RETRYABLE_READ_STATUSES.has(response.status)) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          continue;
        }
        let parsed = {};
        try {
          parsed = JSON.parse(buf.toString('utf8'));
        } catch {}
        throw mapGoogleApiError(response.status, parsed, response.headers, writeFlag);
      }

      if (responseType === 'buffer') {
        return { buffer: buf, contentType: response.headers?.get?.('content-type') || null };
      }
      if (responseType === 'text') {
        return buf.toString('utf8');
      }
      const text = buf.toString('utf8').trim();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new GoogleHttpError(
          'invalid_json',
          writeFlag ? `Resposta inválida do Google. ${UNCERTAIN_WRITE_WARNING}` : 'Resposta JSON inválida do Google.',
          { status: response.status, uncertainWrite: writeFlag }
        );
      }
    }
    throw new GoogleHttpError('network', 'Falha ao consultar o Google após tentativa de repetição.');
  }

  return {
    send: (req) => requestRaw(req, { accept: 'application/json', responseType: 'json' }),
    text: (req) => requestRaw(req, { accept: 'text/plain, */*', responseType: 'text' }),
    download: (req) => requestRaw(req, { accept: '*/*', responseType: 'buffer' })
  };
}
