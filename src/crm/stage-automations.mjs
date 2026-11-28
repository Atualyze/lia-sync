/**
 * Automações nativas por mudança de estágio no funil do CRM.
 */
export function applyStageAutomations({ session, newStage = '', botConfig = {}, notifyAdmin = null, now = () => Date.now() } = {}) {
  const stage = String(newStage || '').trim().toLowerCase();
  if (!session || !stage) return { matched: 0, addedTags: [], notified: false };
  const rules = Array.isArray(botConfig?.crm?.stageAutomations) ? botConfig.crm.stageAutomations : [];
  const matching = rules.filter(r => r && String(r.stage || '').trim().toLowerCase() === stage && r.enabled !== false);
  if (!matching.length) return { matched: 0, addedTags: [], notified: false };

  const addedTags = [];
  let notified = false;
  if (!Array.isArray(session.tags)) session.tags = [];

  for (const rule of matching) {
    for (const rawTag of Array.isArray(rule.addTags) ? rule.addTags : []) {
      const tag = String(rawTag || '').trim().slice(0, 40);
      if (tag && !session.tags.includes(tag)) {
        session.tags.push(tag);
        addedTags.push(tag);
      }
    }
    const followUpHours = Number(rule.followUpHours);
    if (Number.isFinite(followUpHours) && followUpHours > 0) {
      session.nextFollowUpAt = new Date(now() + followUpHours * 3600_000).toISOString();
    }
    if (rule.notifyAdmin === true && typeof notifyAdmin === 'function') {
      notified = true;
      const label = session.contactName || session.name || session.phone || 'Contato';
      Promise.resolve(
        notifyAdmin(`📌 *CRM:* *${label}* avançou para o estágio *${stage}*.`)
      ).catch(() => {});
    }
  }

  return { matched: matching.length, addedTags, notified };
}
