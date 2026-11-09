/**
 * Ferramenta: consultar_saude_infra
 * Permite que a Lia consulte a saúde do Dokku, VPS, Nginx, Docker e instâncias.
 * Executa checagens seguras via HTTP / Endpoints locais sem instalar agentes pesados.
 */
export const toolConsultarSaudeInfra = {
  name: 'consultar_saude_infra',
  description: 'Consulta o estado de saúde, uptime, memória e integridade dos serviços da VPS, instâncias e APIs.',
  parameters: {
    type: 'OBJECT',
    properties: {
      target: {
        type: 'STRING',
        description: 'Serviço a consultar: "geral", "dokku", "vps", "evolution", "supabase", "banco", ou url específica.',
        default: 'geral'
      }
    }
  },
  async execute({ target = 'geral' }, context = {}) {
    const memory = process.memoryUsage();
    const heapUsedMb = Math.round(memory.heapUsed / 1024 / 1024);
    const rssMb = Math.round(memory.rss / 1024 / 1024);
    const uptimeHours = (process.uptime() / 3600).toFixed(1);

    const checks = [
      { name: 'Lia Bot Runtime', status: 'online', details: `Heap: ${heapUsedMb}MB | RSS: ${rssMb}MB | Uptime: ${uptimeHours}h` }
    ];

    // Checagem Evolution API
    const evoUrl = process.env.EVOLUTION_API_URL || 'http://evolution-api:8080';
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`${evoUrl}/`, { signal: controller.signal }).catch(() => null);
      clearTimeout(tid);
      if (res && (res.ok || res.status === 404 || res.status === 200)) {
        checks.push({ name: 'Evolution API (WhatsApp)', status: 'online', code: res.status });
      } else {
        checks.push({ name: 'Evolution API (WhatsApp)', status: 'degradado / offline' });
      }
    } catch {
      checks.push({ name: 'Evolution API (WhatsApp)', status: 'inacessível' });
    }

    // Checagem Supabase Runtime
    if (context.store?.client?.enabled) {
      checks.push({ name: 'Supabase Database & Realtime', status: 'online / sincronizado' });
    } else {
      checks.push({ name: 'Supabase Database', status: 'fallback local ativo' });
    }

    // Se o alvo for Dokku ou instâncias adicionais configuradas no ambiente
    const dokkuHosts = (process.env.DOKKU_HEALTH_ENDPOINTS || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const dHost of dokkuHosts) {
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(dHost, { signal: controller.signal }).catch(() => null);
        clearTimeout(tid);
        const isOk = res && res.ok;
        checks.push({ name: `App Dokku (${dHost})`, status: isOk ? 'online' : 'instável', statusHttp: res?.status });
      } catch (err) {
        checks.push({ name: `App Dokku (${dHost})`, status: 'timeout / erro', error: err.message });
      }
    }

    const allOk = checks.every(c => c.status.includes('online'));

    return {
      success: true,
      health: allOk ? 'healthy' : 'warning',
      timestamp: new Date().toISOString(),
      checks
    };
  }
};
