import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.mjs';

const STALE_THRESHOLD_MS = 15_000;

function resolveMetricsPath() {
  if (process.env.VPS_METRICS_PATH) {
    return process.env.VPS_METRICS_PATH;
  }
  // `config.dataFile` é o caminho canônico do estado local (não existe `dataDir`).
  const dataDir = path.dirname(config.dataFile);
  return path.join(dataDir, 'vps-metrics.json');
}

/**
 * O coletor do host pode registrar a linha de comando inteira de cada processo,
 * e argumentos frequentemente carregam segredos. Expõe apenas o executável.
 */
function sanitizeCommand(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const executable = text.split(/\s+/)[0] || '';
  const basename = executable.split(/[\\/]/).pop() || executable;
  return basename.replace(/[^\w.@+-]/g, '').slice(0, 80);
}

function sanitizeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object' || !Array.isArray(metrics.processes)) return metrics;
  return {
    ...metrics,
    processes: metrics.processes.map(info => (
      info && typeof info === 'object'
        ? { ...info, command: sanitizeCommand(info.command ?? info.cmd ?? '') }
        : info
    ))
  };
}

function buildLocalFallback() {
  const totalMb = Math.round((os.totalmem() / (1024 * 1024)) * 10) / 10;
  const freeMb = Math.round((os.freemem() / (1024 * 1024)) * 10) / 10;
  const usedMb = Math.round((totalMb - freeMb) * 10) / 10;
  const usedPct = totalMb > 0 ? Math.round((usedMb / totalMb) * 1000) / 10 : 0;
  const load = os.loadavg();
  const procMem = process.memoryUsage();

  return {
    ok: true,
    source: 'local-fallback',
    stale: false,
    age_seconds: 0,
    metrics: {
      collected_at: new Date().toISOString(),
      hostname: os.hostname(),
      uptime_seconds: Math.round(os.uptime()),
      cpu: {
        cores: os.cpus().length,
        usage_pct: 0,
        load_1m: Math.round(load[0] * 100) / 100,
        load_5m: Math.round(load[1] * 100) / 100,
        load_15m: Math.round(load[2] * 100) / 100,
      },
      memory: {
        total_mb: totalMb,
        used_mb: usedMb,
        free_mb: freeMb,
        available_mb: freeMb,
        cached_mb: 0,
        used_pct: usedPct,
      },
      swap: {
        total_mb: 0,
        used_mb: 0,
        free_mb: 0,
        used_pct: 0,
        devices: [],
      },
      disk: null,
      docker_disk: null,
      containers: [],
      processes: [
        {
          pid: process.pid,
          user: os.userInfo().username || 'node',
          cpu_pct: 0,
          mem_pct: totalMb > 0 ? Math.round(((procMem.rss / (1024 * 1024)) / totalMb) * 1000) / 10 : 0,
          rss_mb: Math.round((procMem.rss / (1024 * 1024)) * 10) / 10,
          vsz_mb: Math.round((procMem.heapTotal / (1024 * 1024)) * 10) / 10,
          stat: 'R',
          command: `node (${process.platform})`,
        },
      ],
    },
  };
}

/**
 * Lê as métricas somente-leitura coletadas pelo daemon do host VPS.
 * Em ambiente local (sem vps-metrics.json), retorna fallback via node:os.
 */
export async function readVpsMetrics() {
  const filePath = resolveMetricsPath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const metrics = JSON.parse(raw);
    const collectedMs = Date.parse(metrics?.collected_at || '');
    const ageMs = Number.isFinite(collectedMs) ? Math.max(0, Date.now() - collectedMs) : 0;
    return {
      ok: true,
      source: 'host-collector',
      stale: ageMs > STALE_THRESHOLD_MS,
      age_seconds: Math.round(ageMs / 1000),
      metrics: sanitizeMetrics(metrics),
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return buildLocalFallback();
    }
    return {
      ...buildLocalFallback(),
      warning: `Falha ao ler ${path.basename(filePath)}: ${err?.message || 'erro desconhecido'}`,
    };
  }
}
