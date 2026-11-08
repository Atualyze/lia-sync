const storageKey = 'homevet-session';
const requestTimeoutMs = 15000;

const headers = (key, token) => ({
  apikey: key,
  Authorization: `Bearer ${token || key}`,
  'content-type': 'application/json'
});

function readStoredSession() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    localStorage.removeItem(storageKey);
    return null;
  }
}

function sessionExpired(value) {
  if (!value?.access_token) return true;
  if (!value.expires_at) return false;
  return Number(value.expires_at) * 1000 <= Date.now() + 30000;
}

function saveSession(value) {
  if (!value?.access_token) {
    localStorage.removeItem(storageKey);
    return;
  }
  const next = { ...value };
  if (!next.expires_at && next.expires_in) next.expires_at = Math.floor(Date.now() / 1000) + Number(next.expires_in);
  localStorage.setItem(storageKey, JSON.stringify(next));
}

function errorFrom(status, data, fallback = 'Não foi possível conectar ao Supabase.') {
  const message = data?.message || data?.error_description || data?.msg || data?.error;
  const error = new Error(message || fallback);
  error.status = status;
  error.code = data?.code || data?.error || '';
  error.details = data;
  return error;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await parseResponse(response);
    if (!response.ok) throw errorFrom(response.status, data, `Supabase respondeu com HTTP ${response.status}.`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Tempo limite ao conectar ao Supabase.');
    if (error instanceof TypeError) throw new Error('Não foi possível conectar ao Supabase. Verifique a URL, a rede e o CORS.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createClient(url, key) {
  const baseUrl = String(url || '').replace(/\/$/, '');
  let session = readStoredSession();
  const listeners = new Set();
  const emit = (event = 'SIGNED_IN') => listeners.forEach((fn) => fn(event, session));
  const clearSession = (event = 'SIGNED_OUT') => {
    session = null;
    localStorage.removeItem(storageKey);
    emit(event);
  };

  async function refreshSession() {
    if (!session?.refresh_token) return null;
    try {
      const next = await request(`${baseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      session = next;
      saveSession(session);
      emit('TOKEN_REFRESHED');
      return session;
    } catch {
      // Falhas transitórias de rede não devem apagar uma sessão válida do navegador.
      return null;
    }
  }

  return {
    auth: {
      async getSession() {
        if (sessionExpired(session)) {
          if (session?.refresh_token) await refreshSession();
          else clearSession('SIGNED_OUT');
        }
        return { data: { session }, error: null };
      },

      async signInWithPassword({ email, password, captchaToken }) {
        if (!baseUrl || !key) return { data: { session: null }, error: new Error('Supabase não está configurado no servidor.') };
        try {
          const next = await request(`${baseUrl}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: headers(key),
            body: JSON.stringify({ email, password, ...(captchaToken ? { captcha_token: captchaToken } : {}) })
          });
          if (!next.access_token) throw errorFrom(502, next, 'O Supabase não retornou um token de sessão válido.');
          session = next;
          saveSession(session);
          emit('SIGNED_IN');
          return { data: { session }, error: null };
        } catch (error) {
          return { data: { session: null }, error };
        }
      },

      async signOut() {
        const current = session;
        clearSession('SIGNED_OUT');
        if (current?.access_token && baseUrl && key) {
          try {
            await request(`${baseUrl}/auth/v1/logout`, {
              method: 'POST',
              headers: headers(key, current.access_token)
            });
          } catch {
            // O logout local já foi concluído; falha remota não deve prender o usuário.
          }
        }
      },

      onAuthStateChange(fn) {
        listeners.add(fn);
        return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } };
      }
    }
  };
}
