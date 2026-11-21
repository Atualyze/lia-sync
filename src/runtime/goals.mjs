import crypto from 'node:crypto';

export const GOAL_STATUSES = Object.freeze(['draft', 'active', 'paused', 'completed', 'cancelled', 'failed']);
export const GOAL_PRIORITIES = Object.freeze(['low', 'medium', 'high', 'critical']);

const STATUS_SET = new Set(GOAL_STATUSES);
const PRIORITY_SET = new Set(GOAL_PRIORITIES);

function clampProgress(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function normalizeIsoOrNull(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

export class GoalEngine {
  constructor({ store, now = () => Date.now(), onGoalEvent = null } = {}) {
    this.store = store;
    this.now = now;
    this.onGoalEvent = onGoalEvent;
  }

  async create({
    title,
    description = '',
    indicator = '',
    targetValue = null,
    currentValue = 0,
    progress = 0,
    priority = 'medium',
    status = 'active',
    deadlineAt = null,
    metadata = {}
  } = {}) {
    const cleanTitle = String(title || '').trim().slice(0, 200);
    if (!cleanTitle) throw new Error('goal_title_required');
    const cleanStatus = STATUS_SET.has(status) ? status : 'draft';
    const cleanPriority = PRIORITY_SET.has(priority) ? priority : 'medium';
    const nowIso = new Date(this.now()).toISOString();
    const goal = {
      id: crypto.randomUUID(),
      title: cleanTitle,
      description: String(description || '').trim().slice(0, 1000),
      indicator: String(indicator || '').trim().slice(0, 120),
      target_value: targetValue !== null && targetValue !== undefined && Number.isFinite(Number(targetValue)) ? Number(targetValue) : null,
      current_value: Number.isFinite(Number(currentValue)) ? Number(currentValue) : 0,
      progress: clampProgress(progress),
      priority: cleanPriority,
      status: cleanStatus,
      deadline_at: normalizeIsoOrNull(deadlineAt),
      task_ids: [],
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {},
      created_at: nowIso,
      updated_at: nowIso,
      completed_at: cleanStatus === 'completed' ? nowIso : null
    };
    const saved = await this.store.upsertGoal(goal);
    if (typeof this.onGoalEvent === 'function') {
      await this.onGoalEvent('goal.created', saved).catch(() => {});
    }
    return saved;
  }

  async get(id) {
    return this.store.getGoal(id);
  }

  async list({ status = null, priority = null } = {}) {
    const all = await this.store.listGoals();
    return all.filter(goal => {
      if (status && goal.status !== status) return false;
      if (priority && goal.priority !== priority) return false;
      return true;
    });
  }

  async update(id, patch = {}) {
    const current = await this.store.getGoal(id);
    if (!current) return null;
    const nowIso = new Date(this.now()).toISOString();
    const nextStatus = patch.status && STATUS_SET.has(patch.status) ? patch.status : current.status;
    const nextPriority = patch.priority && PRIORITY_SET.has(patch.priority) ? patch.priority : current.priority;
    const nextCurrentValue = patch.currentValue !== undefined && Number.isFinite(Number(patch.currentValue))
      ? Number(patch.currentValue)
      : (patch.current_value !== undefined && Number.isFinite(Number(patch.current_value)) ? Number(patch.current_value) : current.current_value);
    const nextTargetValue = patch.targetValue !== undefined
      ? (patch.targetValue === null ? null : Number(patch.targetValue))
      : (patch.target_value !== undefined ? (patch.target_value === null ? null : Number(patch.target_value)) : current.target_value);
    let nextProgress = patch.progress !== undefined ? clampProgress(patch.progress) : current.progress;
    if (patch.progress === undefined && Number.isFinite(nextTargetValue) && nextTargetValue > 0 && Number.isFinite(nextCurrentValue)) {
      nextProgress = clampProgress((nextCurrentValue / nextTargetValue) * 100);
    }
    if (nextStatus === 'completed') nextProgress = 100;

    const updated = {
      ...current,
      title: patch.title !== undefined ? String(patch.title).trim().slice(0, 200) || current.title : current.title,
      description: patch.description !== undefined ? String(patch.description).trim().slice(0, 1000) : current.description,
      indicator: patch.indicator !== undefined ? String(patch.indicator).trim().slice(0, 120) : current.indicator,
      target_value: nextTargetValue,
      current_value: nextCurrentValue,
      progress: nextProgress,
      priority: nextPriority,
      status: nextStatus,
      deadline_at: patch.deadlineAt !== undefined
        ? normalizeIsoOrNull(patch.deadlineAt)
        : (patch.deadline_at !== undefined ? normalizeIsoOrNull(patch.deadline_at) : current.deadline_at),
      metadata: patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)
        ? { ...(current.metadata || {}), ...patch.metadata }
        : current.metadata,
      updated_at: nowIso,
      completed_at: nextStatus === 'completed' ? (current.completed_at || nowIso) : (nextStatus === 'active' ? null : current.completed_at)
    };
    const saved = await this.store.upsertGoal(updated);
    if (typeof this.onGoalEvent === 'function') {
      await this.onGoalEvent('goal.updated', saved).catch(() => {});
    }
    return saved;
  }

  async pause(id) {
    return this.update(id, { status: 'paused' });
  }

  async resume(id) {
    return this.update(id, { status: 'active' });
  }

  async complete(id) {
    return this.update(id, { status: 'completed', progress: 100 });
  }

  async cancel(id, reason = '') {
    return this.update(id, {
      status: 'cancelled',
      ...(reason ? { metadata: { cancel_reason: String(reason).slice(0, 240) } } : {})
    });
  }

  async fail(id, reason = '') {
    return this.update(id, {
      status: 'failed',
      ...(reason ? { metadata: { failure_reason: String(reason).slice(0, 240) } } : {})
    });
  }

  async linkTask(goalId, taskId) {
    const current = await this.store.getGoal(goalId);
    const cleanTaskId = String(taskId || '').trim();
    if (!current || !cleanTaskId) return null;
    const existing = Array.isArray(current.task_ids) ? current.task_ids : [];
    if (existing.includes(cleanTaskId)) return current;
    const updated = {
      ...current,
      task_ids: [...existing, cleanTaskId].slice(-100),
      updated_at: new Date(this.now()).toISOString()
    };
    return this.store.upsertGoal(updated);
  }

  async findDueDeadlines(nowMs = this.now()) {
    const active = await this.list({ status: 'active' });
    return active.filter(goal => {
      if (!goal.deadline_at) return false;
      const dueTs = Date.parse(goal.deadline_at);
      return Number.isFinite(dueTs) && dueTs <= nowMs;
    });
  }
}
