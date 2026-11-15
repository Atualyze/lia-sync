import { ProspectLeadStore } from './lead-store.mjs';
import { importProspectLeads } from './importer.mjs';
import { evaluateProspectGuards, isWithinBusinessWindow, computeWarmupDailyCap } from './guards.mjs';
import { runProspectingTick, renderFallbackTemplate } from './scheduler.mjs';
import { handleInboundOptOut, isOptOutMessage } from './optout.mjs';

export function createProspecting({ client = null, sender, campaignStore, sessionStore = null, adminConfig = null, env = process.env } = {}) {
  const leadStore = new ProspectLeadStore({ client });
  const enabled = String(env.PROSPECTING_ENABLED || 'false').toLowerCase() === 'true';

  const getRuntimeConfig = () => ({
    timeZone: adminConfig?.active?.business?.hoursConfig?.timezone || adminConfig?.active?.business?.timezone || 'America/Sao_Paulo',
    dailyCap: Number(env.PROSPECTING_DAILY_CAP) || 20,
    warmupDays: Number(env.PROSPECTING_WARMUP_DAYS) || 21,
    windowStart: (env.PROSPECTING_WINDOW || '09:00-18:00').split('-')[0] || '09:00',
    windowEnd: (env.PROSPECTING_WINDOW || '09:00-18:00').split('-')[1] || '18:00'
  });

  return {
    enabled,
    leadStore,
    importLeads: importProspectLeads,
    handleInboundOptOut: params => handleInboundOptOut({ ...params, campaignStore, prospectStore: leadStore, send: sender }),
    tick: (opts = {}) => runProspectingTick({
      enabled,
      leadStore,
      campaignStore,
      sessionStore,
      send: sender,
      config: getRuntimeConfig(),
      ...opts
    })
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
