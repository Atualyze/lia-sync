import { evaluateProspectGuards } from './guards.mjs';

export function renderFallbackTemplate(template = '', lead = {}) {
  const firstName = String(lead.name || '').trim().split(/\s+/)[0] || 'tudo bem';
  return String(template || 'Olá {{nome}}, tudo bem? Caso não queira receber novas mensagens, responda SAIR.')
    .replace(/\{\{\s*nome\s*\}\}/gi, firstName)
    .replace(/\{\{\s*empresa\s*\}\}/gi, String(lead.context?.company || lead.context?.segment || '').trim())
    .trim();
}

/**
 * Executa um ciclo do agendador de prospecção: seleciona leads vencidos, aplica
 * os guards de segurança, reserva o lead de forma atômica e envia pelo adapter
 * de WhatsApp.
 *
 * `dryRun` é uma pré-visualização real, não um "modo de teste": com ele o ciclo
 * NÃO chama `send`, NÃO reserva o lead (`claimLead`) e NÃO grava eventos
 * (`recordEvent`). Os guards continuam valendo por inteiro — o que aparece em
 * `summary.details` é exatamente quem passaria nos guards agora, com a mensagem
 * que seria enviada. É esse caminho que o botão "Testar Agora" do painel usa.
 */
export async function runProspectingTick({
  enabled = false,
  dryRun = false,
  leadStore,
  campaignStore,
  sessionStore = null,
  send,
  template = 'Olá {{nome}}, tudo bem? Gostaria de apresentar rapidamente nossa solução. Se preferir não receber mensagens, responda SAIR.',
  batchSize = 5,
  now = new Date(),
  config = {}
} = {}) {
  const empty = { skipped: true, dryRun, sent: 0, blocked: 0, failed: 0, previewed: 0, details: [] };
  if (!enabled) return { ...empty, reason: 'disabled' };
  if (!leadStore) return { ...empty, reason: 'missing_dependencies' };
  // Em dryRun o `send` não é usado; em envio real ele é obrigatório.
  if (!dryRun && typeof send !== 'function') return { ...empty, reason: 'missing_dependencies' };

  const due = await leadStore.listDueLeads({ limit: batchSize, now });
  const summary = { skipped: false, dryRun, checked: due.length, sent: 0, blocked: 0, failed: 0, previewed: 0, details: [] };

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

    if (dryRun) {
      summary.previewed += 1;
      summary.details.push({
        leadId: lead.id,
        phone: lead.phone,
        status: 'preview',
        message: renderFallbackTemplate(template, lead)
      });
      continue;
    }

    // Reserva o lead e a vaga do cap diário no mesmo passo do claim. O cap já foi
    // avaliado nos guards; aqui ele é reavaliado imediatamente antes de reservar,
    // porque entre os dois passos outra réplica pode ter consumido a cota.
    const claimed = await claimWithinCap(leadStore, lead, guard.effectiveCap, now);
    if (!claimed.lead) {
      if (claimed.blocked) summary.blocked += 1;
      summary.details.push({
        leadId: lead.id,
        phone: lead.phone,
        status: claimed.blocked ? 'blocked' : 'skipped',
        reason: claimed.blocked || 'claim_lost'
      });
      continue;
    }

    let stage = lead.stage || 0;
    try {
      const message = renderFallbackTemplate(template, lead);
      await send(lead.phone, message);
      stage = (lead.stage || 0) + 1;
      await leadStore.releaseClaim(lead.id, claimed.lead.claim_token, {
        status: 'contacted',
        stage,
        last_contacted_at: now.toISOString(),
        attempts: (lead.attempts || 0) + 1,
        last_error: null
      });
      await leadStore.recordEvent({
        listId: lead.list_id,
        leadId: lead.id,
        phone: lead.phone,
        eventType: 'sent',
        stage
      });
      summary.sent += 1;
      summary.details.push({ leadId: lead.id, phone: lead.phone, status: 'sent', stage });
    } catch (err) {
      await leadStore.releaseClaim(lead.id, claimed.lead.claim_token, {
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

/**
 * Reserva o lead. Usa `claimLeadWithinCap` quando o store suporta (revalida o cap
 * e faz o claim atômico); caso contrário cai para `claimLead` puro.
 */
async function claimWithinCap(leadStore, lead, effectiveCap, now) {
  if (typeof leadStore.claimLeadWithinCap === 'function' && Number.isFinite(effectiveCap)) {
    const outcome = await leadStore.claimLeadWithinCap(lead.id, {
      dailyCap: effectiveCap,
      listId: lead.list_id || null,
      now
    });
    return outcome?.claimed ? { lead: outcome.claimed } : { lead: null, blocked: outcome?.blocked || null };
  }
  const claimed = await leadStore.claimLead(lead.id, { now });
  return claimed ? { lead: claimed } : { lead: null };
}
