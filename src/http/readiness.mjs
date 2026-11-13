import { config } from '../config.mjs';
import { getCircuitBreakers } from '../ai.mjs';

const DEFAULT_TIMEOUT_MS = 1500;

function withTimeout(promise, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.resolve(promise(controller.signal)).finally(() => clearTimeout(timer));
}

async function probeHttp(url, headers, timeoutMs) {
  try {
    const response = await withTimeout(signal => fetch(url, { method: 'GET', headers, signal }), timeoutMs);
    return { ok: response.ok || response.status === 401 || response.status === 403 || response.status === 404, status: response.status };
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

  // Evolution is an essential dependency whenever its integration is configured.
  if (config.evolutionUrl || config.evolutionInstance || config.evolutionKey) {
    required.push('evolution');
    const result = await (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(`${config.evolutionUrl}/`, { headers: config.evolutionKey ? { apikey: config.evolutionKey } : {}, signal: controller.signal });
          return { ok: response.ok || response.status === 401 || response.status === 403 || response.status === 404, status: response.status };
        } finally { clearTimeout(timer); }
      } catch (error) { return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable' }; }
    })();
    checks.push(maskedDependency('evolution', result.ok ? 'ready' : 'unavailable', result));
  }

  if (config.supabaseRuntimeEnabled && (config.supabaseUrl || config.supabaseServiceRoleKey)) {
    required.push('supabase');
    const result = await (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/`, { headers: config.supabaseServiceRoleKey ? { apikey: config.supabaseServiceRoleKey, Authorization: `Bearer ${config.supabaseServiceRoleKey}` } : {}, signal: controller.signal });
          return { ok: response.ok || response.status === 401 || response.status === 403 || response.status === 404, status: response.status };
        } finally { clearTimeout(timer); }
      } catch (error) { return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable' }; }
    })();
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
