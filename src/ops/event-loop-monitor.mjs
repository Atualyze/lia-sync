import { performance } from 'node:perf_hooks';

export const EVENT_LOOP_STALL_INTERVAL_MS = 2_000;
export const EVENT_LOOP_STALL_THRESHOLD_MS = 2_000;
const MAX_RECENT_STALLS = 20;

export function classifyEventLoopStall({
  stallMs = 0,
  monotonicElapsedMs = 0,
  wallElapsedMs = 0,
  cpuMs = 0
} = {}) {
  const half = stallMs / 2;
  if (wallElapsedMs - monotonicElapsedMs >= half) return 'host_suspended';
  if (cpuMs >= half) return 'main_thread_cpu';
  return 'blocked_off_cpu';
}

let activeMonitor = null;

export function createEventLoopMonitor({
  intervalMs = EVENT_LOOP_STALL_INTERVAL_MS,
  thresholdMs = EVENT_LOOP_STALL_THRESHOLD_MS,
  logger = console,
  onStall = null,
  probes = {}
} = {}) {
  const monotonicNow = probes.monotonicNow || (() => performance.now());
  const wallNow = probes.wallNow || (() => Date.now());
  const cpuUsage = probes.cpuUsage || (() => process.cpuUsage());
  const memoryUsage = probes.memoryUsage || (() => process.memoryUsage());

  let timer = null;
  let lastMonotonic = monotonicNow();
  let lastWall = wallNow();
  let lastCpu = cpuUsage();
  let totalStalls = 0;
  let maxStallMs = 0;
  let lastStall = null;
  const recentStalls = [];

  function sample() {
    const nowMonotonic = monotonicNow();
    const nowWall = wallNow();
    const nowCpu = cpuUsage();
    const monotonicElapsedMs = Math.max(0, nowMonotonic - lastMonotonic);
    const wallElapsedMs = Math.max(0, nowWall - lastWall);
    const stallMs = Math.max(0, monotonicElapsedMs - intervalMs);

    const cpuUserMs = Math.max(0, (nowCpu.user - lastCpu.user) / 1000);
    const cpuSystemMs = Math.max(0, (nowCpu.system - lastCpu.system) / 1000);
    const cpuMs = cpuUserMs + cpuSystemMs;

    const prevWall = lastWall;
    lastMonotonic = nowMonotonic;
    lastWall = nowWall;
    lastCpu = nowCpu;

    if (stallMs < thresholdMs) return null;

    const mem = memoryUsage();
    const entry = {
      stallMs: Math.round(stallMs),
      monotonicElapsedMs: Math.round(monotonicElapsedMs),
      wallElapsedMs: Math.round(wallElapsedMs),
      stallStartedAt: new Date(prevWall + intervalMs).toISOString(),
      stallEndedAt: new Date(nowWall).toISOString(),
      likelyCause: classifyEventLoopStall({ stallMs, monotonicElapsedMs, wallElapsedMs, cpuMs }),
      cpuUserMs: Math.round(cpuUserMs),
      cpuSystemMs: Math.round(cpuSystemMs),
      rssMB: Math.round((mem.rss || 0) / 1048576),
      heapUsedMB: Math.round((mem.heapUsed || 0) / 1048576)
    };

    totalStalls += 1;
    if (entry.stallMs > maxStallMs) maxStallMs = entry.stallMs;
    lastStall = entry;
    recentStalls.push(entry);
    if (recentStalls.length > MAX_RECENT_STALLS) recentStalls.shift();

    logger?.warn?.(
      `[event-loop] stall detectado (${entry.stallMs}ms, causa=${entry.likelyCause}, rss=${entry.rssMB}MB, heap=${entry.heapUsedMB}MB)`
    );
    if (typeof onStall === 'function') {
      try {
        onStall(entry);
      } catch {}
    }
    return entry;
  }

  function start() {
    if (timer) return;
    lastMonotonic = monotonicNow();
    lastWall = wallNow();
    lastCpu = cpuUsage();
    timer = setInterval(sample, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function getSnapshot() {
    const recentWindowMs = 15 * 60 * 1000;
    const now = wallNow();
    const recentCount = recentStalls.filter(s => now - Date.parse(s.stallEndedAt) <= recentWindowMs).length;
    return {
      running: Boolean(timer),
      thresholdMs,
      totalStalls,
      recentStalls15m: recentCount,
      maxStallMs,
      status: recentCount >= 5 ? 'degraded' : 'healthy',
      lastStall
    };
  }

  return { start, stop, sample, getSnapshot };
}

export function startGlobalEventLoopMonitor(options = {}) {
  if (activeMonitor) return activeMonitor;
  activeMonitor = createEventLoopMonitor(options);
  activeMonitor.start();
  return activeMonitor;
}

export function stopGlobalEventLoopMonitor() {
  if (!activeMonitor) return;
  activeMonitor.stop();
  activeMonitor = null;
}

export function getEventLoopHealthSnapshot() {
  if (!activeMonitor) {
    return {
      running: false,
      thresholdMs: EVENT_LOOP_STALL_THRESHOLD_MS,
      totalStalls: 0,
      recentStalls15m: 0,
      maxStallMs: 0,
      status: 'healthy',
      lastStall: null
    };
  }
  return activeMonitor.getSnapshot();
}
