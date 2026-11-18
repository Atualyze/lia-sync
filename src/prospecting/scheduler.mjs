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

export async function runProspectingTick({
  enabled = false,
  dryRun = false,
  leadStore,
  campaignStore,
  sessionStore = null,
  send,
  stageOutboundDispatch,
  template = DEFAULT_TEMPLATE,
  batchSize = 5,
  now = new Date(),
  config = {}
} = {}) {
  const empty = { skipped: true, dryRun, sent: 0, blocked: 0, failed: 0, previewed: 0, persistenceErrors: 0, details: [] };
  if (!enabled) return { ...empty, reason: 'disabled' };
  if (!leadStore || (!dryRun && typeof stageOutboundDispatch !== 'function')) return { ...empty, reason: 'confirmation_gate_unavailable' };

  const due = await leadStore.listDueLeads({ limit: batchSize, scanLimit: Math.max(batchSize * 5, batchSize), now });
  const summary = { skipped: false, dryRun, checked: due.length, sent: 0, blocked: 0, failed: 0, previewed: 0, persistenceErrors: 0, details: [] };

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

    const cadenceStep = lead.list?.cadence?.steps?.[lead.stage || 0];
    const stepTemplate = typeof cadenceStep === 'string' ? cadenceStep : (cadenceStep?.template || template);
    const message = renderFallbackTemplate(stepTemplate, lead);
    try {
      const currentStage = Number(lead.stage || 0);
      const nextStage = currentStage + 1;
      const nextStep = lead.list?.cadence?.steps?.[nextStage];
      const nextDelayMinutes = Number(nextStep?.delayMinutes ?? (Number(nextStep?.delayHours || 0) * 60));
      const hasNextStep = Boolean(nextStep);
      const nextActionAt = hasNextStep ? new Date(now.getTime() + Math.max(1, nextDelayMinutes || 1440) * 60000).toISOString() : null;
      const pending = await stageOutboundDispatch({
        phone: lead.phone,
        recipient: lead.name || lead.phone,
        message
      }, {
        source: 'prospecting',
        metadata: {
          sourceRef: lead.id,
          leadId: lead.id,
          listId: lead.list_id,
          claimToken: claimed.lead.claim_token,
          leadStage: currentStage,
          hasNextStep,
          nextActionAt,
          attempts: Number(lead.attempts || 0) + 1,
          originalNextActionAt: lead.next_action_at || now.toISOString()
        }
      });
      if (!pending) {
        await leadStore.releaseClaim(lead.id, claimed.lead.claim_token, {
          status: 'queued',
          next_action_at: lead.next_action_at || now.toISOString(),
          last_error: null
        });
        summary.blocked += 1;
        summary.details.push({ leadId: lead.id, phone: lead.phone, status: 'blocked', reason: 'copilot_dispatch_pending' });
        continue;
      }
      summary.previewed += 1;
      summary.details.push({ leadId: lead.id, phone: lead.phone, status: 'pending_approval', stage: currentStage });
    } catch (err) {
      try {
        await leadStore.releaseClaim(lead.id, claimed.lead.claim_token, {
          status: 'queued',
          next_action_at: lead.next_action_at || now.toISOString(),
          last_error: String(err?.message || 'send_failed').slice(0, 300)
        });
      } catch { summary.persistenceErrors += 1; }
      summary.failed += 1;
      summary.details.push({ leadId: lead.id, phone: lead.phone, status: 'failed', retryable: true, error: String(err?.message || 'preview_failed') });
    }
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
