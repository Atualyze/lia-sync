import { ProspectLeadStore } from './lead-store.mjs';
import { importProspectLeads } from './importer.mjs';
import { evaluateProspectGuards, isWithinBusinessWindow, computeWarmupDailyCap } from './guards.mjs';
import { runProspectingTick, renderFallbackTemplate } from './scheduler.mjs';
import { handleInboundOptOut, isOptOutMessage } from './optout.mjs';

export function createProspecting({ client = null, sender, campaignStore, sessionStore = null, adminConfig = null, env = process.env } = {}) {
  const leadStore = new ProspectLeadStore({ client });

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
      testMode: Boolean(ui.testMode),
      defaultTemplate: ui.defaultTemplate || undefined
    };
  };

  return {
    get enabled() { return isEnabled(); },
    leadStore,
    importLeads: importProspectLeads,
    handleInboundOptOut: params => handleInboundOptOut({ ...params, campaignStore, prospectStore: leadStore, send: sender }),
    tick: (opts = {}) => {
      const cfg = { ...getRuntimeConfig(), ...(opts.config || {}) };
      return runProspectingTick({
        enabled: opts.enabled ?? isEnabled(),
        leadStore,
        campaignStore,
        sessionStore,
        send: sender,
        template: cfg.defaultTemplate,
        ...opts,
        config: cfg
      });
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
