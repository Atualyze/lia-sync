import { config } from '../config.mjs';
import { getCircuitBreakers } from '../ai/config.mjs';
import { getBaileysProvider } from '../whatsapp.mjs';
import { getEventLoopHealthSnapshot } from '../ops/event-loop-monitor.mjs';

const TARGETS = new Set(['geral', 'dokku', 'vps', 'evolution', 'baileys', 'whatsapp', 'supabase', 'banco', 'ai', 'apis']);
const validTarget = target => { const value = String(target || 'geral').trim().toLowerCase(); if (TARGETS.has(value)) return value; try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null; return url; } catch { return null; } };
const probe = async (url, headers = {}, timeoutMs = 2500) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { const response = await fetch(url, { headers, signal: controller.signal }); return { ok: response.ok || [401, 403, 404].includes(response.status), status: response.status }; } catch (error) { return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable' }; } finally { clearTimeout(timer); } };
const check = (name, result) => ({ name, status: result.ok ? 'online' : 'offline', ...(result.status === undefined ? {} : { httpStatus: result.status }), ...(result.reason ? { reason: result.reason } : {}) });
export const toolConsultarSaudeInfra = {
  name: 'consultar_saude_infra', description: 'Consulta o estado de saúde, uptime, memória, WhatsApp (Baileys/Evolution), Supabase e provedores de IA configurados.',
  parameters: { type: 'OBJECT', properties: { target: { type: 'STRING', description: 'Serviço: geral, dokku, vps, whatsapp, baileys, evolution, supabase, banco, ai, apis ou URL HTTP(S) sem credenciais.' } } },
  async execute({ target = 'geral' } = {}, context = {}) {
    const selected = validTarget(target);
    if (!selected) return { success: false, healthy: false, error: 'invalid_target', message: 'target inválido; use um alvo permitido ou URL HTTP(S) sem credenciais.' };
    const memory = process.memoryUsage();
    const el = getEventLoopHealthSnapshot();
    const elInfo = el.totalStalls > 0 ? ` | Stalls(15m): ${el.recentStalls15m} (máx ${el.maxStallMs}ms)` : ' | Event Loop: estável';
    const checks = [{ name: 'Lia Bot Runtime', status: el.status === 'degraded' ? 'degraded' : 'online', details: `Heap: ${Math.round(memory.heapUsed / 1048576)}MB | RSS: ${Math.round(memory.rss / 1048576)}MB | Uptime: ${(process.uptime() / 3600).toFixed(1)}h${elInfo}` }];
    const include = name => selected === 'geral' || selected === name;
    if (selected instanceof URL) checks.push(check('URL configurada', await probe(selected.toString())));
    if (include('evolution') || include('baileys') || include('whatsapp')) {
      if (config.whatsappProvider === 'baileys' && selected !== 'evolution') {
        const bp = getBaileysProvider?.();
        const st = bp?.getStatus?.() || { status: 'disconnected' };
        checks.push({
          name: 'WhatsApp Nativo (Baileys)',
          status: st.status === 'connected' ? 'online' : 'offline',
          details: st.phone ? `Conectado (${st.phone})` : `Estado: ${st.status || 'disconnected'}`
        });
      } else if (process.env.EVOLUTION_API_URL) {
        checks.push(check('Evolution API (WhatsApp)', await probe(`${process.env.EVOLUTION_API_URL.replace(/\/$/, '')}/`, process.env.EVOLUTION_API_KEY ? { apikey: process.env.EVOLUTION_API_KEY } : {})));
      } else {
        checks.push({ name: 'Evolution API (WhatsApp)', status: 'not_configured' });
      }
    }
    if (include('supabase') || include('banco')) checks.push({ name: 'Supabase Database', status: context.store?.client?.enabled ? 'online' : 'fallback_local' });
    if (include('ai') || include('apis')) {
      const breakers = getCircuitBreakers();
      const configured = Object.entries(breakers).filter(([, info]) => info?.configured);
      if (!configured.length) {
        checks.push({ name: 'Provedores de IA', status: 'offline', reason: 'nenhum provedor com chave configurada' });
      } else {
        const summary = configured.map(([id, info]) => `${id}: ${info.status}${info.lastErrorCode ? ` (${info.lastErrorCode})` : ''}`).join(' | ');
        const anyHealthy = configured.some(([, info]) => info.status === 'operacional');
        checks.push({ name: 'Provedores de IA', status: anyHealthy ? 'online' : 'degraded', details: summary });
      }
    }
    if (include('dokku')) {
      const endpoints = (process.env.DOKKU_HEALTH_ENDPOINTS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!endpoints.length) checks.push({ name: 'Dokku', status: 'not_configured' });
      for (let i = 0; i < endpoints.length; i++) checks.push(check(`App Dokku #${i + 1}`, await probe(endpoints[i])));
    }
    const healthy = checks.every(item => ['online', 'fallback_local', 'not_configured'].includes(item.status));
    return { success: true, healthy, health: healthy ? 'healthy' : 'warning', target: selected instanceof URL ? 'custom_url' : selected, timestamp: new Date().toISOString(), checks };
  }
};
