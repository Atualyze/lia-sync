import { evaluateProspectGuards } from './guards.mjs';

export function renderFallbackTemplate(template = '', lead = {}) {
  const firstName = String(lead.name || '').trim().split(/\s+/)[0] || 'tudo bem';
  return String(template || 'Olá {{nome}}, tudo bem? Caso não queira receber novas mensagens, responda SAIR.')
    .replace(/\{\{\s*nome\s*\}\}/gi, firstName)
    .replace(/\{\{\s*empresa\s*\}\}/gi, String(lead.context?.company || lead.context?.segment || '').trim())
    .trim();
}

/**
 * Runs a single prospecting scheduler tick: picks due leads, checks guards,
 * atomically claims each lead, and sends via the WhatsApp adapter.
 */
export async function runProspectingTick({
  enabled = false,
  leadStore,
  campaignStore,
  sessionStore = null,
  send,
  template = 'Olá {{nome}}, tudo bem? Gostaria de apresentar rapidamente nossa solução. Se preferir não receber mensagens, responda SAIR.',
  batchSize = 5,
  now = new Date(),
  config = {}
} = {}) {
  if (!enabled) return { skipped: true, reason: 'disabled', sent: 0, blocked: 0, failed: 0 };
  if (!leadStore || !send) return { skipped: true, reason: 'missing_dependencies', sent: 0, blocked: 0, failed: 0 };

  const due = await leadStore.listDueLeads({ limit: batchSize, now });
  const summary = { skipped: false, checked: due.length, sent: 0, blocked: 0, failed: 0, details: [] };

  for (const lead of due) {
    const guard = await evaluateProspectGuards({
      lead,
      list: lead.list || {},
      now,
      campaignStore,
      sessionStore,
      leadStore,
      config
    });

    if (!guard.allowed) {
      summary.blocked += 1;
      summary.details.push({ leadId: lead.id, phone: lead.phone, status: 'blocked', reason: guard.reason });
      continue;
    }

    const claimed = await leadStore.claimLead(lead.id);
    if (!claimed) continue;

    try {
      const message = renderFallbackTemplate(template, lead);
      await send(lead.phone, message);
      const nextStage = (lead.stage || 0) + 1;
      await leadStore.releaseClaim(lead.id, claimed.claim_token, {
        status: 'contacted',
        stage: nextStage,
        last_contacted_at: now.toISOString(),
        attempts: (lead.attempts || 0) + 1,
        last_error: null
      });
      await leadStore.recordEvent({
        listId: lead.list_id,
        leadId: lead.id,
        phone: lead.phone,
        eventType: 'sent',
        stage: nextStage
      });
      summary.sent += 1;
      summary.details.push({ leadId: lead.id, phone: lead.phone, status: 'sent', stage: nextStage });
    } catch (err) {
      await leadStore.releaseClaim(lead.id, claimed.claim_token, {
        status: 'failed',
        attempts: (lead.attempts || 0) + 1,
        last_error: String(err?.message || 'send_failed').slice(0, 300)
      });
      await leadStore.recordEvent({
        listId: lead.list_id,
        leadId: lead.id,
        phone: lead.phone,
        eventType: 'failed',
        stage: lead.stage || 0,
        detail: { error: String(err?.message || 'send_failed') }
      });
      summary.failed += 1;
      summary.details.push({ leadId: lead.id, phone: lead.phone, status: 'failed' });
    }
  }

  return summary;
}
