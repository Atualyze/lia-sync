const TARGETS = new Set(['geral', 'dokku', 'vps', 'evolution', 'supabase', 'banco']);
const validTarget = target => { const value = String(target || 'geral').trim(); if (TARGETS.has(value)) return value; try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null; return url; } catch { return null; } };
const probe = async (url, headers = {}, timeoutMs = 2500) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { const response = await fetch(url, { headers, signal: controller.signal }); return { ok: response.ok || [401, 403, 404].includes(response.status), status: response.status }; } catch (error) { return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable' }; } finally { clearTimeout(timer); } };
const check = (name, result) => ({ name, status: result.ok ? 'online' : 'offline', ...(result.status === undefined ? {} : { httpStatus: result.status }), ...(result.reason ? { reason: result.reason } : {}) });
export const toolConsultarSaudeInfra = {
  name: 'consultar_saude_infra', description: 'Consulta o estado de saúde, uptime, memória e integridade dos serviços configurados.',
  parameters: { type: 'OBJECT', properties: { target: { type: 'STRING', description: 'Serviço: geral, dokku, vps, evolution, supabase, banco ou URL HTTP(S) sem credenciais.' } } },
  async execute({ target = 'geral' } = {}, context = {}) {
    const selected = validTarget(target);
    if (!selected) return { success: false, healthy: false, error: 'invalid_target', message: 'target inválido; use um alvo permitido ou URL HTTP(S) sem credenciais.' };
    const memory = process.memoryUsage();
    const checks = [{ name: 'Lia Bot Runtime', status: 'online', details: `Heap: ${Math.round(memory.heapUsed / 1048576)}MB | RSS: ${Math.round(memory.rss / 1048576)}MB | Uptime: ${(process.uptime() / 3600).toFixed(1)}h` }];
    const include = name => selected === 'geral' || selected === name;
    if (selected instanceof URL) checks.push(check('URL configurada', await probe(selected.toString())));
    if (include('evolution')) {
      if (process.env.EVOLUTION_API_URL) checks.push(check('Evolution API (WhatsApp)', await probe(`${process.env.EVOLUTION_API_URL.replace(/\/$/, '')}/`, process.env.EVOLUTION_API_KEY ? { apikey: process.env.EVOLUTION_API_KEY } : {})));
      else checks.push({ name: 'Evolution API (WhatsApp)', status: 'not_configured' });
    }
    if (include('supabase')) checks.push({ name: 'Supabase Database', status: context.store?.client?.enabled ? 'online' : 'fallback_local' });
    if (include('dokku')) {
      const endpoints = (process.env.DOKKU_HEALTH_ENDPOINTS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!endpoints.length) checks.push({ name: 'Dokku', status: 'not_configured' });
      for (let i = 0; i < endpoints.length; i++) checks.push(check(`App Dokku #${i + 1}`, await probe(endpoints[i])));
    }
    const healthy = checks.every(item => item.status === 'online' || item.status === 'fallback_local');
    return { success: true, healthy, health: healthy ? 'healthy' : 'warning', target: selected instanceof URL ? 'custom_url' : selected, timestamp: new Date().toISOString(), checks };
  }
};
