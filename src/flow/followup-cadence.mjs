import { filterReply } from '../safety.mjs';
import { isHumanHandoffActive } from './human-handoff-state.mjs';

const SKIP_STAGES = new Set(['transferido', 'fechado']);

/**
 * Avalia e executa um passo da cadência de follow-up para sessões ociosas.
 * Cada passo define: { delayMinutes, stageFilter?, message }.
 * Retorna { sent, skipped, results }.
 */
export async function runFollowUpCadence({
  sessions = {},
  cadence = [],
  now = Date.now(),
  maxDaily = 30,
  sendText,
  onSent = null,
}) {
  const steps = (Array.isArray(cadence) ? cadence : [])
    .filter((s) => Number(s?.delayMinutes) > 0 && String(s?.message || '').trim())
    .sort((a, b) => Number(a.delayMinutes) - Number(b.delayMinutes));

  if (!steps.length || typeof sendText !== 'function') {
    return { sent: 0, skipped: 0, results: [] };
  }

  let sent = 0;
  let skipped = 0;
  const results = [];

  for (const [key, session] of Object.entries(sessions)) {
    if (sent >= maxDaily) break;
    if (!session || key.startsWith('sim:') || session.origin === 'simulation' || session.notALead) {
      skipped++;
      continue;
    }
    if (isHumanHandoffActive(session)) {
      skipped++;
      continue;
    }
    const stage = session.funnelStage || 'novo';
    if (SKIP_STAGES.has(stage)) {
      skipped++;
      continue;
    }

    const history = Array.isArray(session.history) ? session.history : [];
    const lastMsg = history.length ? history[history.length - 1] : null;
    if (!lastMsg) {
      skipped++;
      continue;
    }

    // Só envia follow-up se a última mensagem foi do bot (lead parou de responder)
    const lastRole = lastMsg.role || (lastMsg.fromMe ? 'assistant' : 'user');
    if (lastRole === 'user') {
      skipped++;
      continue;
    }

    const lastAt = Date.parse(session.updatedAt || lastMsg.timestamp || '');
    if (!Number.isFinite(lastAt)) {
      skipped++;
      continue;
    }

    const idleMinutes = (now - lastAt) / 60000;
    const currentStepIdx = Number(session.cadenceStep || 0);
    const nextStep = steps[currentStepIdx];
    if (!nextStep) {
      skipped++;
      continue;
    }
    if (nextStep.stageFilter && nextStep.stageFilter !== 'all' && nextStep.stageFilter !== stage) {
      skipped++;
      continue;
    }
    if (idleMinutes < Number(nextStep.delayMinutes)) {
      skipped++;
      continue;
    }

    const filtered = filterReply(String(nextStep.message), { strictPrices: false });
    const text = typeof filtered === 'string' ? filtered : (filtered?.text || String(nextStep.message));
    const target = session.jid || session.phone || key;

    await sendText(target, text);
    session.cadenceStep = currentStepIdx + 1;
    session.lastCadenceAt = new Date(now).toISOString();
    session.updatedAt = new Date(now).toISOString();
    sent++;
    results.push({ phone: session.phone || key, step: session.cadenceStep, delayMinutes: nextStep.delayMinutes });
    onSent?.(session, nextStep);
  }

  return { sent, skipped, results };
}
