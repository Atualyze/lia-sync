import { ProspectLeadStore } from './lead-store.mjs';
import { importProspectLeads } from './importer.mjs';
import { evaluateProspectGuards, isWithinBusinessWindow, computeWarmupDailyCap } from './guards.mjs';
import { runProspectingTick, renderFallbackTemplate } from './scheduler.mjs';
import { handleInboundOptOut, isOptOutMessage } from './optout.mjs';

export function createProspecting({ client = null, sender, campaignStore, sessionStore = null, adminConfig = null } = {}) {
  const leadStore = new ProspectLeadStore({ client });
  let activeTick = null;

  const isEnabled = () => {
    return adminConfig?.active?.prospecting?.enabled === true;
  };

  const getRuntimeConfig = () => {
    const ui = adminConfig?.active?.prospecting || {};
    return {
      timeZone: adminConfig?.active?.business?.hoursConfig?.timezone || adminConfig?.active?.business?.timezone,
      dailyCap: Number(ui.dailyCap),
      warmupDays: Number(ui.warmupDays),
      windowStart: ui.windowStart,
      windowEnd: ui.windowEnd,
      minDelayMs: Number(ui.minDelayMs),
      maxDelayMs: Number(ui.maxDelayMs),
      maxAttempts: Number(ui.maxAttempts),
      retryBaseMinutes: Number(ui.retryBaseMinutes),
      defaultTemplate: ui.defaultTemplate
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
