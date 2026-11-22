import { LiaRuntimeStore } from './store.mjs';
import { LiaIdentityStore } from './identity.mjs';
import { GoalEngine } from './goals.mjs';
import { EventEngine } from './events.mjs';
import { CommitmentStore } from './commitments.mjs';
import { computeNextRecurrenceIso } from './schedule-parser.mjs';
import { evaluateAttention, SAFE_RUNTIME_READ_TOOLS } from './attention.mjs';
import { createCopilotTaskKey } from '../copilot-tasks.mjs';
import { isBackgroundCopilotTool } from '../copilot-task-worker.mjs';
import { buildCopilotToolPlan } from '../flow/copilot-tool-plan.mjs';
import { isToolEnabled } from '../tools/index.mjs';
import { OWNER_SELF_KEY } from '../core/identity.mjs';

export const RUNTIME_STATES = Object.freeze([
  'idle',
  'observing',
  'evaluating',
  'planning',
  'working',
  'waiting',
  'blocked',
  'needs_human',
  'recovering'
]);

const STUCK_ACTIVE_STATES = new Set(['observing', 'evaluating', 'planning', 'working']);
const DEFAULT_WORKING_TIMEOUT_MS = 5 * 60 * 1000;

export function createLiaRuntime({
  store,
  taskStore = null,
  learningEngine = null,
  getBotConfig = () => ({}),
  getHumanPhone = () => '',
  notifyOwner = null,
  notifyCommitmentRecipient = null,
  workingTimeoutMs = DEFAULT_WORKING_TIMEOUT_MS,
  logger = console,
  now = () => Date.now()
} = {}) {
  const runtimeStore = store || new LiaRuntimeStore({ logger, now });
  const identity = new LiaIdentityStore({ store: runtimeStore, getBotConfig, now });
  const events = new EventEngine({ store: runtimeStore, now, logger });
  const commitments = new CommitmentStore({ store: runtimeStore, now });
  const goals = new GoalEngine({
    store: runtimeStore,
    now,
    onGoalEvent: async (type, goal) => {
      if (!runtimeStore.available) return;
      await events.emit({
        type,
        source: 'goal_engine',
        subject: goal.id,
        priority: goal.priority,
        deduplicationKey: `${type}:${goal.id}:${goal.updated_at}`,
        payload: {
          goal_id: goal.id,
          title: goal.title,
          status: goal.status,
          progress: goal.progress
        }
      });
    }
  });

  const logs = [];
  let waking = false;
  let currentState = 'idle';

  const emitLog = (eventName, details = {}) => {
    const entry = {
      event: eventName,
      at: new Date(now()).toISOString(),
      state: currentState,
      ...details
    };
    logs.push(entry);
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    logger.info?.(`[lia-runtime] ${eventName}`, JSON.stringify(details));
    return entry;
  };

  const setState = async (nextState, extra = {}) => {
    currentState = nextState;
    if (!runtimeStore.available) return null;
    const nowIso = new Date(now()).toISOString();
    const prev = await runtimeStore.getRuntimeState().catch(() => null);
    return runtimeStore.saveRuntimeState({
      ...(prev || {}),
      id: 'primary',
      state: nextState,
      state_entered_at: nowIso,
      ...extra
    });
  };

  const validateSafeTaskPlan = (steps = []) => {
    if (!Array.isArray(steps) || !steps.length || steps.length > 4) return null;
    const botConfig = getBotConfig() || {};
    for (const step of steps) {
      const name = String(step?.name || '');
      if (!SAFE_RUNTIME_READ_TOOLS.has(name)) return null;
      if (!isBackgroundCopilotTool(name, step.args)) return null;
      if (!isToolEnabled(name, botConfig)) return null;
    }
    const plan = buildCopilotToolPlan(steps, { botConfig, actor: 'owner' });
    if (!plan?.canExecute || !plan.steps?.length) return null;
    return plan.steps;
  };

  const enqueuePlannedTask = async ({ event, attention, steps }) => {
    if (!taskStore?.available) return null;
    const safeSteps = validateSafeTaskPlan(steps);
    if (!safeSteps) return null;
    const taskKey = createCopilotTaskKey({
      messageId: `runtime:${event.id}`,
      ownerKey: OWNER_SELF_KEY
    });
    const task = await taskStore.enqueue({
      taskKey,
      ownerKey: OWNER_SELF_KEY,
      targetPhone: String(getHumanPhone() || '').replace(/\D/g, ''),
      actorLabel: 'Lia Runtime',
      requestSummary: `[Runtime] ${event.type}: ${String(attention.attention_reason || '').slice(0, 160)}`,
      steps: safeSteps,
      retryPolicy: 'read_only'
    });
    if (task?.created) {
      emitLog('runtime.task_created', {
        eventId: event.id,
        taskId: task.id,
        tools: safeSteps.map(s => s.name)
      });
    }
    if (task?.id && Array.isArray(attention.related_goal_ids)) {
      for (const goalId of attention.related_goal_ids) {
        await goals.linkTask(goalId, task.id).catch(() => {});
      }
    }
    return task;
  };

  const recoverIfNeeded = async () => {
    if (!runtimeStore.available) return false;
    const persisted = await runtimeStore.getRuntimeState();
    const staleEvents = await events.recoverStaleProcessing(workingTimeoutMs);
    let recoveredState = false;
    if (persisted && STUCK_ACTIVE_STATES.has(persisted.state)) {
      const enteredTs = Date.parse(persisted.state_entered_at || persisted.updated_at || '');
      if (!Number.isFinite(enteredTs) || now() - enteredTs >= workingTimeoutMs) {
        await setState('recovering', { last_recovery_at: new Date(now()).toISOString() });
        recoveredState = true;
      }
    }
    if (recoveredState || staleEvents > 0) {
      emitLog('runtime.recovered', {
        previousState: persisted?.state || null,
        staleEventsRecovered: staleEvents
      });
      await setState('idle');
      return true;
    }
    return false;
  };

  const start = async () => {
    await runtimeStore.load();
    if (!runtimeStore.available) {
      currentState = 'blocked';
      emitLog('runtime.started', { available: false, mode: runtimeStore.mode, reason: runtimeStore.remoteError || (runtimeStore.localCorrupt ? 'local_store_corrupt' : 'unavailable') });
      return { ok: false, mode: runtimeStore.mode };
    }
    await identity.ensure();
    await recoverIfNeeded();
    await setState('idle');
    const [activeGoals, pendingCommitments] = await Promise.all([
      goals.list({ status: 'active' }),
      commitments.list({ status: 'pending' })
    ]);
    await identity.syncOperationalView({
      currentStatus: 'idle',
      activeObjectives: activeGoals,
      activeCommitments: pendingCommitments
    });
    emitLog('runtime.started', {
      available: true,
      mode: runtimeStore.mode,
      activeGoals: activeGoals.length,
      pendingCommitments: pendingCommitments.length
    });
    return { ok: true, mode: runtimeStore.mode };
  };

  const emitEvent = async (eventInput) => {
    if (!runtimeStore.available) throw new Error('lia_runtime_unavailable');
    const result = await events.emit(eventInput);
    if (result.created) {
      emitLog('runtime.event_received', {
        eventId: result.event.id,
        type: result.event.type,
        source: result.event.source,
        priority: result.event.priority
      });
    }
    return result;
  };

  const wake = async ({ reason = 'manual', maxEvents = 15 } = {}) => {
    if (waking) return { ok: true, skipped: true, reason: 'already_waking' };
    if (!runtimeStore.available) {
      currentState = 'blocked';
      return { ok: false, reason: 'runtime_unavailable' };
    }
    waking = true;
    const summary = {
      ok: true,
      reason,
      recovered: false,
      dueCommitments: 0,
      dueGoals: 0,
      processedEvents: 0,
      tasksCreated: 0,
      needsHumanCount: 0
    };
    try {
      summary.recovered = await recoverIfNeeded();
      await setState('observing', { last_wake_at: new Date(now()).toISOString() });
      emitLog('runtime.woke', { reason });

      // 1. Verificar compromissos vencendo -> gerar evento commitment.due
      const dueCommitments = await commitments.findDue(now());
      for (const commitment of dueCommitments) {
        const emitted = await emitEvent({
          type: 'commitment.due',
          source: 'commitment_scheduler',
          subject: commitment.subject || commitment.id,
          priority: 'high',
          deduplicationKey: `commitment.due:${commitment.id}`,
          payload: {
            commitment_id: commitment.id,
            title: commitment.title,
            due_at: commitment.due_at,
            goal_id: commitment.goal_id,
            conversation_id: commitment.conversation_id || '',
            recipient_type: commitment.recipient_type || 'owner',
            recipient_phone: commitment.recipient_phone || '',
            owner_type: commitment.owner_type || 'owner',
            category: commitment.category || 'outro',
            metadata: commitment.metadata || {}
          }
        });
        await commitments.markDueEventEmitted(commitment.id, emitted.event.id);
        summary.dueCommitments += 1;
      }

      // 2. Verificar prazos de objetivos ativos -> gerar evento goal.deadline
      const dueGoals = await goals.findDueDeadlines(now());
      for (const goal of dueGoals) {
        const emitted = await emitEvent({
          type: 'goal.deadline',
          source: 'goal_scheduler',
          subject: goal.id,
          priority: goal.priority === 'critical' ? 'critical' : 'high',
          deduplicationKey: `goal.deadline:${goal.id}:${goal.deadline_at}`,
          payload: {
            goal_id: goal.id,
            title: goal.title,
            progress: goal.progress,
            deadline_at: goal.deadline_at
          }
        });
        if (emitted.created) summary.dueGoals += 1;
      }

      // 3. Processar eventos pendentes (limitado por ciclo)
      const pendingEvents = await events.listPending(Math.max(1, Math.min(50, Number(maxEvents) || 15)));
      const [idRecord, activeGoals] = await Promise.all([
        identity.get(),
        goals.list({ status: 'active' })
      ]);

      for (const event of pendingEvents) {
        await setState('evaluating');
        const outcome = await events.dispatchOne(event, async (evt) => {
          const attention = evaluateAttention(evt, {
            activeGoals,
            operatingMode: idRecord.operating_mode
          });
          emitLog('runtime.attention_evaluated', {
            eventId: evt.id,
            type: evt.type,
            score: attention.attention_score,
            priority: attention.priority,
            recommendedAction: attention.recommended_action,
            requiresHuman: attention.requires_human
          });
          if (attention.related_goal_ids.length) {
            emitLog('runtime.goal_evaluated', {
              eventId: evt.id,
              goalIds: attention.related_goal_ids
            });
          }
          if (attention.requires_human) {
            summary.needsHumanCount += 1;
          }
          if (attention.recommended_action === 'enqueue_read_task' && Array.isArray(attention.suggested_plan)) {
            await setState('planning');
            emitLog('runtime.action_planned', {
              eventId: evt.id,
              action: attention.recommended_action,
              tools: attention.suggested_plan.map(s => s.name)
            });
            await setState('working');
            const task = await enqueuePlannedTask({ event: evt, attention, steps: attention.suggested_plan });
            if (task?.created) summary.tasksCreated += 1;
          } else if (evt.type === 'commitment.due') {
            const meta = evt.payload?.metadata || {};
            const commitmentId = evt.payload?.commitment_id;
            if (meta.actionTool) {
              await setState('planning');
              const scheduledTask = await enqueuePlannedTask({
                event: evt,
                attention: {
                  ...attention,
                  attention_reason: evt.payload?.title || 'Verificação autônoma agendada'
                },
                steps: [{ name: meta.actionTool, args: meta.actionArgs || {} }]
              });
              if (scheduledTask?.created) summary.tasksCreated += 1;
              // O compromisso acompanha a tarefa até seu estado terminal.
              if (commitmentId && scheduledTask?.id) {
                const current = await commitments.get(commitmentId).catch(() => null);
                await commitments.start(commitmentId, {
                  metadata: { ...(current?.metadata || meta), linkedTaskId: scheduledTask.id, linkedTaskStatus: scheduledTask.status || 'queued' }
                }).catch(() => {});
              } else if (commitmentId) {
                await commitments.markOverdue(commitmentId, 'scheduled_task_enqueue_failed').catch(() => {});
              }
            } else {
              const commitment = {
                ...evt.payload,
                id: commitmentId,
                title: evt.payload?.title || 'Compromisso agendado',
                subject: evt.subject || '',
                metadata: meta
              };
              let recipientResult = null;
              if (evt.payload?.recipient_type === 'client' && typeof notifyCommitmentRecipient === 'function') {
                recipientResult = await notifyCommitmentRecipient(commitment).catch(error => ({
                  sent: false,
                  reason: error?.code || error?.name || 'client_notification_failed'
                }));
              }
              const clientWasNotified = recipientResult?.sent === true;
              const mustNotifyOwner = evt.payload?.owner_type === 'owner'
                || evt.payload?.recipient_type !== 'client'
                || !clientWasNotified
                || meta.notifyOwner === true;
              if (mustNotifyOwner && typeof notifyOwner === 'function') {
                const label = evt.payload?.title || 'Compromisso agendado';
                const subject = evt.payload?.conversation_id || evt.subject;
                const reason = recipientResult?.reason
                  ? '\\n• *Motivo:* ' + String(recipientResult.reason).slice(0, 180)
                  : '';
                await notifyOwner(
                  '⚠️ *Compromisso vencido — precisa de conferência*\\n\\n• *Tarefa:* ' + label
                  + (subject ? '\\n• *Conversa/Contato:* ' + subject : '') + reason
                  + '\\n\\nO compromisso continua rastreado até ser cumprido ou cancelado.'
                ).catch(() => {});
              }
              if (commitmentId) {
                await commitments.markOverdue(
                  commitmentId,
                  clientWasNotified ? 'deadline_elapsed_customer_followup_sent' : (recipientResult?.reason || 'deadline_elapsed_owner_notified')
                ).catch(() => {});
              }
            }
            // Se for rotina recorrente, agenda automaticamente a próxima ocorrência preservando metadata
            if (meta.recurrence && typeof meta.recurrence === 'object') {
              const tz = getBotConfig()?.businessHours?.timezone || 'America/Sao_Paulo';
              const nextDueAt = computeNextRecurrenceIso(meta.recurrence, now(), tz);
              if (nextDueAt) {
                await commitments.create({
                  title: evt.payload?.title || 'Rotina autônoma recorrente',
                  subject: evt.subject || 'owner',
                  dueAt: nextDueAt,
                  goalId: evt.payload?.goal_id || null,
                  conversationId: evt.payload?.conversation_id || '',
                  recipientType: evt.payload?.recipient_type || 'owner',
                  recipientPhone: evt.payload?.recipient_phone || '',
                  ownerType: evt.payload?.owner_type || 'owner',
                  category: evt.payload?.category || 'outro',
                  metadata: { ...meta }
                }).catch(() => {});
              }
            }
          }
          if (learningEngine?.available) {
            const outcomeMap = {
              'task.completed': 'success',
              'task.failed': 'failure',
              'task.uncertain': 'uncertain',
              'task.expired': 'abandoned',
              'system.error': 'failure',
              'followup.failed': 'failure',
              'followup.success': 'success',
              'lead.converted': 'success',
              'lead.rejected': 'failure'
            };
            if (outcomeMap[evt.type]) {
              await learningEngine.experiences.record({
                deduplicationKey: `rt-exp:${evt.id}`,
                eventType: evt.type,
                source: evt.source,
                subject: evt.subject,
                goalId: attention.related_goal_ids?.[0] || null,
                taskId: evt.payload?.task_id || null,
                action: evt.type,
                actualResult: attention.attention_reason,
                outcome: outcomeMap[evt.type],
                significance: evt.type === 'task.uncertain' || evt.priority === 'critical' ? 'critical' : 'high',
                context: evt.payload
              }).catch(() => {});
            }
          }
          return attention;
        });
        if (outcome.status === 'processed') summary.processedEvents += 1;
      }

      if (learningEngine?.available) {
        await learningEngine.runLearningCycle({ maxBatch: 3 }).catch(() => {});
      }

      const finalStatus = summary.needsHumanCount > 0 ? 'needs_human' : 'idle';
      await setState(finalStatus, { last_sleep_at: new Date(now()).toISOString() });
      const [freshGoals, freshCommitments] = await Promise.all([
        goals.list({ status: 'active' }),
        commitments.list({ status: 'pending' })
      ]);
      await identity.syncOperationalView({
        currentStatus: finalStatus,
        activeObjectives: freshGoals,
        activeCommitments: freshCommitments
      });
      emitLog('runtime.sleep', {
        finalStatus,
        processedEvents: summary.processedEvents,
        tasksCreated: summary.tasksCreated
      });
      return summary;
    } catch (error) {
      const code = String(error?.code || error?.name || 'runtime_wake_error');
      await setState('recovering', { last_error: code }).catch(() => {});
      await setState('idle').catch(() => {});
      emitLog('runtime.recovered', { reason: 'wake_error', error: code });
      return { ok: false, error: code };
    } finally {
      waking = false;
    }
  };

  const readiness = () => {
    const available = runtimeStore.available === true;
    const mode = runtimeStore.mode;
    return {
      name: 'lia_runtime',
      status: available ? 'ready' : 'unavailable',
      mode,
      state: available ? currentState : 'blocked',
      ...(runtimeStore.localCorrupt ? { reason: 'local_store_corrupt' } : {}),
      ...(mode === 'local' && !runtimeStore.localCorrupt ? { reason: 'single_instance_local_fallback' } : {}),
      ...(mode === 'unavailable' && !runtimeStore.localCorrupt && runtimeStore.remoteError ? { reason: runtimeStore.remoteError } : {})
    };
  };

  return {
    store: runtimeStore,
    identity,
    goals,
    events,
    commitments,
    learning: learningEngine,
    start,
    wake,
    emitEvent,
    recoverIfNeeded,
    readiness,
    get state() { return currentState; },
    get available() { return runtimeStore.available; },
    get recentLogs() { return [...logs]; }
  };
}

export { LiaRuntimeStore, LiaIdentityStore, GoalEngine, EventEngine, CommitmentStore, evaluateAttention };
