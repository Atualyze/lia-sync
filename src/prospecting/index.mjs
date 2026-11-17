import { ProspectLeadStore } from './lead-store.mjs';
import { importProspectLeads } from './importer.mjs';
import { evaluateProspectGuards, isWithinBusinessWindow, computeWarmupDailyCap } from './guards.mjs';
import { runProspectingTick, renderFallbackTemplate } from './scheduler.mjs';
import { handleInboundOptOut, isOptOutMessage } from './optout.mjs';

export function createProspecting({ client = null, sender, campaignStore, sessionStore = null, adminConfig = null, env = process.env } = {}) {
  const leadStore = new ProspectLeadStore({ client });
  let activeTick = null;

  const isEnabled = () => {
    if (adminConfig?.active?.prospecting?.enabled !== undefined) {
      return Boolean(adminConfig.active.prospecting.enabled);
    }
    return String(env.PROSPECTING_ENABLED || 'false').toLowerCase() === 'true';
  };

  const getRuntimeConfig = () => {
    const ui = adminConfig?.active?.prospecting || {};
    const envWindow = String(env.PROSPECTING_WINDOW || '09:00-18:00').split('-');
    return {
      timeZone: adminConfig?.active?.business?.hoursConfig?.timezone || adminConfig?.active?.business?.timezone || 'America/Sao_Paulo',
      dailyCap: Number(ui.dailyCap ?? env.PROSPECTING_DAILY_CAP) || 20,
      warmupDays: Number(ui.warmupDays ?? env.PROSPECTING_WARMUP_DAYS ?? 21),
      windowStart: ui.windowStart || envWindow[0] || '09:00',
      windowEnd: ui.windowEnd || envWindow[1] || '18:00',
      minDelayMs: Number(ui.minDelayMs ?? env.PROSPECTING_MIN_DELAY_MS ?? 20000),
      maxDelayMs: Number(ui.maxDelayMs ?? env.PROSPECTING_MAX_DELAY_MS ?? 90000),
      maxAttempts: Number(ui.maxAttempts ?? env.PROSPECTING_MAX_ATTEMPTS ?? 3),
      retryBaseMinutes: Number(ui.retryBaseMinutes ?? env.PROSPECTING_RETRY_BASE_MINUTES ?? 15),
      defaultTemplate: ui.defaultTemplate || undefined
    };
  };

  return {
    get enabled() { return isEnabled(); },
    leadStore,
    importLeads: importProspectLeads,
    handleInboundOptOut: params => handleInboundOptOut({ ...params, campaignStore, prospectStore: leadStore, sessionStore, send: sender }),
    tick: (opts = {}) => {
      if (activeTick) return activeTick.then(() => ({ skipped: true, reason: 'already_running', sent: 0, blocked: 0, failed: 0, previewed: 0, details: [] }));
      const cfg = { ...getRuntimeConfig(), ...(opts.config || {}) };
      activeTick = runProspectingTick({
        enabled: opts.enabled ?? isEnabled(),
        leadStore,
        campaignStore,
        sessionStore,
        send: sender,
        template: cfg.defaultTemplate,
        ...opts,
        config: cfg
      }).finally(() => { activeTick = null; });
      return activeTick;
    }
  };
}

export {
  ProspectLeadStore,
  importProspectLeads,
  evaluateProspectGuards,
  isWithinBusinessWindow,
  computeWarmupDailyCap,
  runProspectingTick,
  renderFallbackTemplate,
  handleInboundOptOut,
  isOptOutMessage
};
