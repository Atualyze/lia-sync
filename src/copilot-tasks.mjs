import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const STATES = new Set(['queued', 'running', 'awaiting_input', 'succeeded', 'failed', 'uncertain', 'cancelled']);
const RETRY_POLICIES = new Set(['read_only', 'never']);
const NOTIFICATION_STATES = new Set(['pending', 'sending', 'sent', 'uncertain', 'unaddressable']);
const iso = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const clone = value => JSON.parse(JSON.stringify(value));

function normalizeStep(step = {}) {
  const name = String(step.name || '').trim();
  if (!/^[a-z][a-z0-9_]{1,63}$/i.test(name)) throw new Error('invalid_copilot_task_tool');
  const args = step.args && typeof step.args === 'object' && !Array.isArray(step.args) ? clone(step.args) : {};
  if (JSON.stringify(args).length > 12000) throw new Error('copilot_task_arguments_too_large');
  return { name, args };
}

function normalizeTaskInput(input = {}) {
  const steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, 4).map(normalizeStep);
  if (!steps.length || steps.length !== (input.steps || []).length) throw new Error('invalid_copilot_task_steps');
  const retryPolicy = RETRY_POLICIES.has(input.retryPolicy) ? input.retryPolicy : 'never';
  const taskKey = String(input.taskKey || '').trim().slice(0, 160);
  if (!taskKey) throw new Error('missing_copilot_task_key');
  const ownerKey = String(input.ownerKey || '').trim().slice(0, 160);
  if (!ownerKey) throw new Error('missing_copilot_task_owner');
  const targetPhone = String(input.targetPhone || '').trim().slice(0, 180);
  const requestSummary = String(input.requestSummary || '').trim().slice(0, 500);
  const actorLabel = String(input.actorLabel || 'responsável').trim().slice(0, 80);
  return { taskKey, ownerKey, targetPhone, requestSummary, actorLabel, steps, retryPolicy };
}

function mapTask(row = {}) {
  return {
    id: String(row.id || ''),
    taskKey: String(row.task_key || row.taskKey || ''),
    ownerKey: String(row.owner_key || row.ownerKey || ''),
    targetPhone: String(row.target_phone || row.targetPhone || ''),
    requestSummary: String(row.request_summary || row.requestSummary || ''),
    actorLabel: String(row.actor_label || row.actorLabel || 'responsável'),
    steps: Array.isArray(row.steps) ? row.steps.map(step => ({ name: String(step.name || ''), args: step.args || {} })) : [],
    retryPolicy: row.retry_policy || row.retryPolicy || 'never',
    status: row.status || 'queued',
    resultText: String(row.result_text || row.resultText || ''),
    resultSummary: row.result_summary || row.resultSummary || null,
    errorCode: row.last_error_code || row.errorCode || null,
    attemptCount: Number(row.attempt_count ?? row.attemptCount ?? 0),
    maxAttempts: Number(row.max_attempts ?? row.maxAttempts ?? 2),
    notificationStatus: row.notification_status || row.notificationStatus || 'pending',
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
    startedAt: row.started_at || row.startedAt || null,
    completedAt: row.completed_at || row.completedAt || null,
    notifiedAt: row.notified_at || row.notifiedAt || null,
    leaseOwner: row.lease_owner || row.leaseOwner || null,
    leaseToken: row.lease_token || row.leaseToken || null,
    leaseExpiresAt: row.lease_expires_at || row.leaseExpiresAt || null
  };
}

export function createCopilotTaskKey({ messageId = '', ownerKey = '', steps = [] } = {}) {
  const source = String(messageId || '').trim();
  const nonce = source || crypto.randomUUID();
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ ownerKey: String(ownerKey), nonce, steps }))
    .digest('hex');
  return `copilot:${digest}`;
}

/**
 * Durable Copilot task queue.
 *
 * Supabase is the distributed source of truth. A local atomic JSON file is
 * retained as a single-process fallback when Supabase is not configured or the
 * queue migration has not yet been applied. A configured-but-unavailable
 * Supabase queue never silently falls back during enqueue.
 */
export class CopilotTaskStore {
  constructor({
    client = null,
    filePath = './data/copilot-tasks.json',
    logger = console,
    now = () => Date.now()
  } = {}) {
    this.client = client;
    this.filePath = filePath;
    this.logger = logger;
    this.now = now;
    this.tasks = [];
    this.mode = 'local';
    this.remoteError = null;
    this.loaded = false;
    this.writing = Promise.resolve();
  }

  get remoteEnabled() {
    return Boolean(this.client?.enabled && this.mode === 'supabase');
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.tasks = parsed.map(mapTask);
      else this.logger.error?.('[copilot-tasks] arquivo local inválido; preservando estado em memória.');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.error?.(`[copilot-tasks] falha ao ler ${path.basename(this.filePath)}: ${error.message}`);
      }
    }

    if (this.client?.enabled) {
      try {
        await this.client.select('copilot_tasks', 'select=id&limit=1');
        this.mode = 'supabase';
        this.remoteError = null;
      } catch (error) {
        this.mode = 'local';
        this.remoteError = error?.message || 'copilot_task_queue_unavailable';
        this.logger.warn?.('[copilot-tasks] fila Supabase indisponível; usando fallback local de uma única réplica. Aplique a migration da fila para coordenação distribuída.');
      }
    }
    this.loaded = true;
    return this.tasks;
  }

  async _saveLocal() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(this.tasks.slice(-1000), null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  _serial(fn) {
    this.writing = this.writing.catch(() => {}).then(fn);
    return this.writing;
  }

  async enqueue(input = {}) {
    if (!this.loaded) await this.load();
    const normalized = normalizeTaskInput(input);
    const createdAt = new Date(this.now()).toISOString();
    const row = {
      id: crypto.randomUUID(),
      task_key: normalized.taskKey,
      owner_key: normalized.ownerKey,
      target_phone: normalized.targetPhone || null,
      request_summary: normalized.requestSummary,
      actor_label: normalized.actorLabel,
      steps: normalized.steps,
      retry_policy: normalized.retryPolicy,
      status: 'queued',
      result_text: null,
      result_summary: null,
      last_error_code: null,
      attempt_count: 0,
      max_attempts: normalized.retryPolicy === 'read_only' ? 2 : 1,
      notification_status: 'pending',
      created_at: createdAt,
      updated_at: createdAt,
      available_at: createdAt
    };

    if (this.remoteEnabled) {
      try {
        const inserted = await this.client.request('copilot_tasks', {
          method: 'POST',
          body: [row],
          prefer: 'return=representation'
        });
        if (Array.isArray(inserted) && inserted[0]) return { ...mapTask(inserted[0]), created: true };
        throw new Error('copilot_task_insert_not_confirmed');
      } catch (error) {
        if (!/\b409\b|duplicate key|unique constraint/i.test(String(error?.message || ''))) throw error;
        const existing = await this.client.select('copilot_tasks', `select=*&task_key=eq.${encodeURIComponent(normalized.taskKey)}&limit=1`);
        if (Array.isArray(existing) && existing[0]) return { ...mapTask(existing[0]), created: false };
        throw error;
      }
    }

    return this._serial(async () => {
      const existing = this.tasks.find(task => task.taskKey === normalized.taskKey);
      if (existing) return { ...clone(existing), created: false };
      const task = mapTask(row);
      this.tasks.push(task);
      await this._saveLocal();
      return { ...clone(task), created: true };
    });
  }

  async claimNext(workerId, leaseSeconds = 180) {
    if (!this.loaded) await this.load();
    const worker = String(workerId || '').trim().slice(0, 120) || 'lia-worker';
    const lease = Math.max(30, Math.min(600, Number(leaseSeconds) || 180));
    if (this.remoteEnabled) {
      const rows = await this.client.rpc('claim_copilot_task', {
        p_worker: worker,
        p_lease_seconds: lease
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return row?.id ? mapTask(row) : null;
    }

    return this._serial(async () => {
      const nowMs = this.now();
      for (const task of this.tasks) {
        if (task.status === 'running' && Date.parse(task.leaseExpiresAt || '') <= nowMs) {
          if (task.retryPolicy === 'read_only' && task.attemptCount < task.maxAttempts) {
            task.status = 'queued';
          } else {
            task.status = 'uncertain';
          }
          task.errorCode = 'worker_lease_expired';
          task.leaseOwner = null;
          task.leaseToken = null;
          task.leaseExpiresAt = null;
          task.updatedAt = new Date(nowMs).toISOString();
        }
        if (task.status === 'succeeded' && task.notificationStatus === 'sending'
          && nowMs - Date.parse(task.updatedAt || '') > 120000) {
          task.notificationStatus = 'uncertain';
          task.errorCode = 'notification_lease_expired';
          task.updatedAt = new Date(nowMs).toISOString();
        }
      }
      const task = this.tasks
        .filter(item => item.status === 'queued' && (!item.availableAt || Date.parse(item.availableAt) <= nowMs))
        .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0))[0];
      if (!task) {
        await this._saveLocal();
        return null;
      }
      task.status = 'running';
      task.attemptCount += 1;
      task.leaseOwner = worker;
      task.leaseToken = crypto.randomUUID();
      task.leaseExpiresAt = new Date(nowMs + lease * 1000).toISOString();
      task.startedAt ||= new Date(nowMs).toISOString();
      task.updatedAt = new Date(nowMs).toISOString();
      await this._saveLocal();
      return clone(task);
    });
  }

  async _patchRunning(task, patch) {
    if (this.remoteEnabled) {
      const rows = await this.client.request('copilot_tasks', {
        method: 'PATCH',
        query: `id=eq.${encodeURIComponent(task.id)}&status=eq.running&lease_token=eq.${encodeURIComponent(task.leaseToken || '')}`,
        body: { ...patch, updated_at: new Date(this.now()).toISOString() },
        prefer: 'return=representation'
      });
      return Array.isArray(rows) && rows.length === 1 ? mapTask(rows[0]) : null;
    }
    return this._serial(async () => {
      const current = this.tasks.find(item => item.id === task.id && item.status === 'running' && item.leaseToken === task.leaseToken);
      if (!current) return null;
      const aliases = {
        result_text: 'resultText',
        result_summary: 'resultSummary',
        last_error_code: 'errorCode',
        completed_at: 'completedAt',
        notification_status: 'notificationStatus',
        lease_owner: 'leaseOwner',
        lease_token: 'leaseToken',
        lease_expires_at: 'leaseExpiresAt',
        current_step: 'currentStep',
        notified_at: 'notifiedAt',
        started_at: 'startedAt'
      };
      for (const [key, value] of Object.entries(patch)) {
        current[aliases[key] || key] = value;
      }
      current.updatedAt = new Date(this.now()).toISOString();
      await this._saveLocal();
      return clone(current);
    });
  }

  async checkpoint(task, { stepIndex, resultSummary } = {}) {
    const index = Number(stepIndex);
    if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error('invalid_copilot_task_step');
    const summary = resultSummary && typeof resultSummary === 'object' ? clone(resultSummary) : {};
    return this._patchRunning(task, { current_step: index + 1, result_summary: summary });
  }

  async succeed(task, { resultText, resultSummary = null } = {}) {
    const text = String(resultText || '').trim().slice(0, 16000);
    if (!text) throw new Error('empty_copilot_task_result');
    return this._patchRunning(task, {
      status: 'succeeded',
      result_text: text,
      result_summary: resultSummary && typeof resultSummary === 'object' ? clone(resultSummary) : null,
      completed_at: new Date(this.now()).toISOString(),
      notification_status: 'pending',
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null
    });
  }

  async fail(task, errorCode = 'tool_execution_failed') {
    return this._patchRunning(task, {
      status: 'failed',
      last_error_code: String(errorCode || 'tool_execution_failed').slice(0, 120),
      completed_at: new Date(this.now()).toISOString(),
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null
    });
  }

  async uncertain(task, errorCode = 'execution_result_uncertain') {
    return this._patchRunning(task, {
      status: 'uncertain',
      last_error_code: String(errorCode || 'execution_result_uncertain').slice(0, 120),
      completed_at: new Date(this.now()).toISOString(),
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null
    });
  }

  async claimPendingNotification() {
    if (!this.loaded) await this.load();
    if (this.remoteEnabled) {
      const rows = await this.client.select('copilot_tasks', 'select=*&status=eq.succeeded&notification_status=eq.pending&order=completed_at.asc&limit=10');
      for (const row of Array.isArray(rows) ? rows : []) {
        const claimed = await this.client.request('copilot_tasks', {
          method: 'PATCH',
          query: `id=eq.${encodeURIComponent(row.id)}&status=eq.succeeded&notification_status=eq.pending`,
          body: { notification_status: 'sending', updated_at: new Date(this.now()).toISOString() },
          prefer: 'return=representation'
        });
        if (Array.isArray(claimed) && claimed[0]) return mapTask(claimed[0]);
      }
      return null;
    }
    return this._serial(async () => {
      const task = this.tasks
        .filter(item => item.status === 'succeeded' && item.notificationStatus === 'pending')
        .sort((a, b) => Date.parse(a.completedAt || 0) - Date.parse(b.completedAt || 0))[0];
      if (!task) return null;
      task.notificationStatus = 'sending';
      task.updatedAt = new Date(this.now()).toISOString();
      await this._saveLocal();
      return clone(task);
    });
  }

  async finishNotification(task, outcome, errorCode = null) {
    const status = outcome === 'sent' ? 'sent' : 'uncertain';
    if (this.remoteEnabled) {
      const rows = await this.client.request('copilot_tasks', {
        method: 'PATCH',
        query: `id=eq.${encodeURIComponent(task.id)}&status=eq.succeeded&notification_status=eq.sending`,
        body: {
          notification_status: status,
          notified_at: status === 'sent' ? new Date(this.now()).toISOString() : null,
          last_error_code: errorCode ? String(errorCode).slice(0, 120) : null,
          updated_at: new Date(this.now()).toISOString()
        },
        prefer: 'return=representation'
      });
      return Array.isArray(rows) && rows.length === 1;
    }
    return this._serial(async () => {
      const current = this.tasks.find(item => item.id === task.id && item.status === 'succeeded' && item.notificationStatus === 'sending');
      if (!current) return false;
      current.notificationStatus = status;
      current.notifiedAt = status === 'sent' ? new Date(this.now()).toISOString() : null;
      current.errorCode = errorCode ? String(errorCode).slice(0, 120) : null;
      current.updatedAt = new Date(this.now()).toISOString();
      await this._saveLocal();
      return true;
    });
  }

  async getLatest(ownerKey) {
    if (!this.loaded) await this.load();
    const owner = String(ownerKey || '').trim();
    if (!owner) return null;
    if (this.remoteEnabled) {
      const rows = await this.client.select(
        'copilot_tasks',
        `select=*&owner_key=eq.${encodeURIComponent(owner)}&order=created_at.desc&limit=1`
      );
      return Array.isArray(rows) && rows[0] ? mapTask(rows[0]) : null;
    }
    return this._serial(async () => {
      const task = this.tasks.filter(item => item.ownerKey === owner)
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0];
      return task ? clone(task) : null;
    });
  }
}

export function describeCopilotTaskStatus(task) {
  if (!task) return '';
  const id = String(task.id || '').slice(0, 8).toUpperCase();
  if (task.status === 'queued') return `A tarefa #${id} está registrada e aguardando execução.`;
  if (task.status === 'running') return `A tarefa #${id} está em execução. Ainda não tenho o resultado confirmado.`;
  if (task.status === 'awaiting_input') return `A tarefa #${id} está aguardando uma informação sua.`;
  if (task.status === 'succeeded' && task.notificationStatus === 'sent') return `A tarefa #${id} foi concluída e o resultado já foi enviado.${task.resultText ? `\\n\\n${task.resultText}` : ''}`;
  if (task.status === 'succeeded' && task.notificationStatus === 'uncertain') return `A tarefa #${id} foi concluída, mas não consegui confirmar a entrega da notificação. Não vou reenviar automaticamente para evitar duplicidade.`;
  if (task.status === 'succeeded') return `A tarefa #${id} foi concluída e o resultado está pronto para entrega.${task.resultText ? `\\n\\n${task.resultText}` : ''}`;
  if (task.status === 'uncertain') return `A execução da tarefa #${id} ficou incerta. Interrompi novas tentativas para não duplicar uma ação. É necessária uma conferência antes de continuar.`;
  if (task.status === 'cancelled') return `A tarefa #${id} foi cancelada.`;
  return `A tarefa #${id} terminou sem conclusão (${task.errorCode || task.status}). Nenhuma repetição automática será feita.`;
}
