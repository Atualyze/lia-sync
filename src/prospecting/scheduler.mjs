import { evaluateProspectGuards } from './guards.mjs';

const DEFAULT_TEMPLATE = 'Olá {{nome}}, tudo bem? Caso não queira receber novas mensagens, responda SAIR.';

export function renderFallbackTemplate(template = '', lead = {}) {
  const firstName = String(lead.name || '').trim().split(/\s+/)[0];
  const company = String(lead.context?.company || lead.context?.segment || '').trim();
  let message = String(template || DEFAULT_TEMPLATE)
    .replace(/\{\{\s*nome\s*\}\}/gi, firstName)
    .replace(/\{\{\s*empresa\s*\}\}/gi, company)
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*([.!?])/g, '$1')
    .trim();
  return message;
}

const wait = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
function randomDelay(min, max) {
  const low = Math.max(0, Number(min) || 0);
  const high = Math.max(low, Number(max) || low);
  return Math.round(low + Math.random() * (high - low));
}

export async function runProspectingTick({
  enabled = false,
  dryRun = false,
  leadStore,
  campaignStore,
  sessionStore = null,
  send,
  template = DEFAULT_TEMPLATE,
  batchSize = 5,
  now = new Date(),
  config = {}
} = {}) {
  const empty = { skipped: true, dryRun, sent: 0, blocked: 0, failed: 0, previewed: 0, persistenceErrors: 0, details: [] };
  if (!enabled) return { ...empty, reason: 'disabled' };
  if (!leadStore || (!dryRun && typeof send !== 'function')) return { ...empty, reason: 'missing_dependencies' };

  const due = await leadStore.listDueLeads({ limit: batchSize, scanLimit: Math.max(batchSize * 5, batchSize), now });
  const summary = { skipped: false, dryRun, checked: due.length, sent: 0, blocked: 0, failed: 0, previewed: 0, persistenceErrors: 0, details: [] };
  let sentInTick = 0;

  for (const lead of due) {
    const guard = await evaluateProspectGuards({ lead, list: lead.list || {}, now, campaignStore, sessionStore, leadStore, config });
    if (!guard.allowed) {
      summary.blocked += 1;
      summary.details.push({ leadId: lead.id, phone: lead.phone, status: 'blocked', reason: guard.reason });
      continue;
    }
    if (dryRun) {
      summary.previewed += 1;
      summary.details.push({ leadId: lead.id, phone: lead.phone, status: 'preview', message: renderFallbackTemplate(template, lead) });
      continue;
    }

    const claimed = await claimWithinCap(leadStore, lead, guard.effectiveCap, now, config.timeZone);
    if (!claimed.lead) {
      if (claimed.blocked) summary.blocked += 1;
      summary.details.push({ leadId: lead.id, phone: lead.phone, status: claimed.blocked ? 'blocked' : 'skipped', reason: claimed.blocked || 'claim_lost' });
      continue;
    }

    if (sentInTick > 0) await wait(randomDelay(config.minDelayMs, config.maxDelayMs));
    const cadenceStep = lead.list?.cadence?.steps?.[lead.stage || 0];
    const stepTemplate = typeof cadenceStep === 'string' ? cadenceStep : (cadenceStep?.template || template);
    const message = renderFallbackTemplate(stepTemplate, lead);
    try {
      await send(lead.phone, message);
    } catch (err) {
      const attempts = (lead.attempts || 0) + 1;
      const maxAttempts = Math.max(1, Number(config.maxAttempts) || 3);
      const retryable = attempts < maxAttempts;
      const retryAt = new Date(now.getTime() + Math.max(1, Number(config.retryBaseMinutes) || 15) * 60000 * (2 ** Math.max(0, attempts - 1))).toISOString();
      try {
        await leadStore.releaseClaim(lead.id, claimed.lead.claim_token, {
          status: retryable ? 'queued' : 'failed',
          next_action_at: retryable ? retryAt : null,
          attempts,
          last_error: String(err?.message || 'send_failed').slice(0, 300)
        });
      } catch { summary.persistenceErrors += 1; }
      try { await leadStore.recordEvent({ listId: lead.list_id, leadId: lead.id, phone: lead.phone, eventType: 'failed', stage: lead.stage || 0, detail: { error: String(err?.message || 'send_failed'), retryable, attempts } }); } catch { summary.persistenceErrors += 1; }
      summary.failed += 1;
      summary.details.push({ leadId: lead.id, phone: lead.phone, status: 'failed', retryable, attempts });
      continue;
    }

    const stage = (lead.stage || 0) + 1;
    const nextStep = lead.list?.cadence?.steps?.[stage];
    const nextDelayMinutes = Number(nextStep?.delayMinutes ?? (Number(nextStep?.delayHours || 0) * 60));
    const hasNextStep = Boolean(nextStep);
    const nextActionAt = hasNextStep ? new Date(now.getTime() + Math.max(1, nextDelayMinutes || 1440) * 60000).toISOString() : null;
    sentInTick += 1;
    summary.sent += 1;
    summary.details.push({ leadId: lead.id, phone: lead.phone, status: 'sent', stage });
    // O envio já aconteceu: falhas de persistência não podem transformar sucesso
    // de WhatsApp em failed nem provocar reenvio indevido.
    try {
      await leadStore.releaseClaim(lead.id, claimed.lead.claim_token, {
        status: hasNextStep ? 'queued' : 'contacted', stage, last_contacted_at: now.toISOString(),
        next_action_at: nextActionAt, attempts: (lead.attempts || 0) + 1, last_error: null
      });
    } catch { summary.persistenceErrors += 1; }
    try { await leadStore.recordEvent({ listId: lead.list_id, leadId: lead.id, phone: lead.phone, eventType: 'sent', stage }); } catch { summary.persistenceErrors += 1; }
  }
  return summary;
}

async function claimWithinCap(leadStore, lead, effectiveCap, now, timeZone) {
  if (typeof leadStore.claimLeadWithinCap === 'function' && Number.isFinite(effectiveCap)) {
    const outcome = await leadStore.claimLeadWithinCap(lead.id, { dailyCap: effectiveCap, listId: lead.list_id || null, now, timeZone });
    return outcome?.claimed ? { lead: outcome.claimed } : { lead: null, blocked: outcome?.blocked || null };
  }
  const claimed = await leadStore.claimLead(lead.id, { now });
  return claimed ? { lead: claimed } : { lead: null };
}
