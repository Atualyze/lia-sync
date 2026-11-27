import { config } from '../config.mjs';
import { getCircuitBreakers } from '../ai.mjs';
import { getBaileysProvider } from '../whatsapp.mjs';

const DEFAULT_TIMEOUT_MS = 1500;

async function probeEvolution(timeoutMs, fetchImpl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${config.evolutionUrl}/`, {
        headers: config.evolutionKey ? { apikey: config.evolutionKey } : {},
        signal: controller.signal
      });
      // A própria API da Evolution responde 401/403/404 quando o endpoint raiz
      // não é exposto; isso prova que o serviço está de pé.
      return { ok: response.ok || response.status === 401 || response.status === 403 || response.status === 404, status: response.status };
    } finally { clearTimeout(timer); }
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  }
}

/**
 * Prova que a credencial de servidor do Supabase é válida e que o schema responde.
 * Uma consulta autenticada real: 401/403 significam credencial recusada, nunca
 * "pronto". Aceita somente 2xx.
 */
async function probeSupabase(timeoutMs, fetchImpl) {
  if (!config.supabaseUrl) return { ok: false, reason: 'not_configured' };
  if (!config.supabaseServiceRoleKey) return { ok: false, reason: 'credentials_missing' };
  const url = `${config.supabaseUrl}/rest/v1/bot_config_state?select=id&limit=1`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          apikey: config.supabaseServiceRoleKey,
          Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
          accept: 'application/json'
        },
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, reason: 'credentials_rejected' };
      }
      if (!response.ok) return { ok: false, status: response.status, reason: `http_${response.status}` };
      return { ok: true, status: response.status };
    } finally { clearTimeout(timer); }
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  }
}

export function maskedDependency(name, status, details = {}) {
  return { name, status, ...(details.status !== undefined ? { httpStatus: details.status } : {}), ...(details.reason ? { reason: details.reason } : {}) };
}

export async function checkReadiness({ timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const checks = [];
  const required = [];

  const baileys = getBaileysProvider();
  if (config.whatsappProvider === 'baileys' && baileys) {
    required.push('whatsapp');
    const isOk = ['connected', 'qr_ready', 'connecting'].includes(baileys.status);
    checks.push(maskedDependency('whatsapp', isOk ? 'ready' : 'unavailable', { reason: baileys.status }));
  } else if (config.evolutionUrl || config.evolutionInstance || config.evolutionKey) {
    // Evolution is an essential dependency whenever its integration is configured.
    required.push('evolution');
    const result = await probeEvolution(timeoutMs, fetchImpl);
    checks.push(maskedDependency('evolution', result.ok ? 'ready' : 'unavailable', result));
  }

  if (config.supabaseRuntimeEnabled && (config.supabaseUrl || config.supabaseServiceRoleKey)) {
    required.push('supabase');
    const result = await probeSupabase(timeoutMs, fetchImpl);
    checks.push(maskedDependency('supabase', result.ok ? 'ready' : 'unavailable', result));
  }

  const providers = getCircuitBreakers();
  const configuredAI = Object.values(providers).some(provider => provider.configured);
  required.push('ai');
  const aiReady = configuredAI && Object.values(providers).some(provider => provider.configured && provider.status !== 'aberto');
  checks.push(maskedDependency('ai', aiReady ? 'ready' : 'unavailable'));

  const failed = checks.filter(check => check.status !== 'ready');
  return { ok: failed.length === 0 && required.length > 0, status: failed.length === 0 && required.length > 0 ? 'ready' : 'not_ready', checks };
}
