import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const STATES = new Set(['queued', 'running', 'awaiting_input', 'succeeded', 'failed', 'uncertain', 'cancelled']);
const RETRY_POLICIES = new Set(['read_only', 'never']);
const READ_ONLY_TASK_TOOLS = new Set([
  'consultar_web', 'consultar_contato_ou_lead', 'consultar_base_conhecimento',
  'consultar_saude_infra', 'consultar_dados_brasil'
]);
const isReadOnlyTaskStep = step => READ_ONLY_TASK_TOOLS.has(step.name)
  || (step.name === 'checkout_infinitepay' && String(step.args?.acao || '') === 'verificar_pagamento')
  || (step.name === 'consultar_planilha_google' && ['ler_intervalo', 'buscar_linhas'].includes(String(step.args?.acao || '')))
  || (step.name === 'gerenciar_drive_google' && ['listar_arquivos', 'buscar_arquivo', 'ler_documento'].includes(String(step.args?.acao || '')))
  || (step.name === 'gerenciar_agenda_google' && ['consultar_livres', 'sugerir_horarios', 'listar_eventos'].includes(String(step.args?.action || '')))
  || (step.name === 'gerenciar_gmail_google' && ['buscar_mensagens', 'ler_mensagem', 'listar_rascunhos'].includes(String(step.args?.acao || '')));
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
  const requestedRetryPolicy = RETRY_POLICIES.has(input.retryPolicy) ? input.retryPolicy : 'never';
  // Política de repetição é derivada do plano, nunca confiada ao chamador.
  const retryPolicy = requestedRetryPolicy === 'read_only' && steps.every(isReadOnlyTaskStep)
    ? 'read_only'
    : 'never';
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
    expiresAt: row.expires_at || row.expiresAt || null,
    notifiedAt: row.notified_at || row.notifiedAt || null,
    leaseOwner: row.lease_owner || row.leaseOwner || null,
    leaseToken: row.lease_token || row.leaseToken || null,
    leaseExpiresAt: row.lease_expires_at || row.leaseExpiresAt || null,
    reconciledAt: row.reconciled_at || row.reconciledAt || null,
    reconciledBy: row.reconciled_by || row.reconciledBy || null,
    reconciliationOutcome: row.reconciliation_outcome || row.reconciliationOutcome || null,
    reconciliationNote: row.reconciliation_note || row.reconciliationNote || null
  };
}

export function createCopilotTaskKey({ messageId = '', ownerKey = '' } = {}) {
  const source = String(messageId || '').trim();
  const nonce = source || crypto.randomUUID();
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ ownerKey: String(ownerKey), nonce }))
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
    now = () => Date.now(),
    allowLocalFallback = false
  } = {}) {
    this.client = client;
    this.filePath = filePath;
    this.logger = logger;
    this.now = now;
    this.allowLocalFallback = allowLocalFallback === true;
    this.onEnqueue = null;
    this.tasks = [];
    this.mode = 'local';
    this.remoteError = null;
    this.localCorrupt = false;
    this.loaded = false;
    this.writing = Promise.resolve();
  }

  get remoteEnabled() {
    return Boolean(this.client?.enabled && this.mode === 'supabase');
  }

  get available() {
    return this.remoteEnabled || (this.mode === 'local' && !this.localCorrupt);
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const validRows = Array.isArray(parsed) && parsed.every(item => item
        && typeof item === 'object'
        && typeof (item.id || item.task_id) === 'string'
        && typeof (item.taskKey || item.task_key) === 'string');
      if (validRows) this.tasks = parsed.map(mapTask);
      else {
        this.localCorrupt = true;
        this.logger.error?.('[copilot-tasks] arquivo local inválido; preservando estado em memória e bloqueando novas gravações.');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.localCorrupt = true;
        this.logger.error?.(`[copilot-tasks] falha ao ler ${path.basename(this.filePath)}: ${error.message}`);
      }
    }

    if (this.client?.enabled) {
      try {
        await this.client.select('copilot_tasks', 'select=id&limit=1');
        const localPending = this.localCorrupt || this.tasks.some(task =>
          ['queued', 'running', 'awaiting_input'].includes(task.status)
          || ['pending', 'sending', 'uncertain'].includes(task.notificationStatus)
        );
        if (localPending) {
          this.mode = 'unavailable';
          this.remoteError = 'copilot_task_local_queue_migration_required';
          this.logger.error?.('[copilot-tasks] há tarefas locais pendentes; reconcilie a fila local antes de mudar para Supabase. Execução bloqueada para evitar perda ou duplicidade.');
        } else {
          this.mode = 'supabase';
          this.remoteError = null;
        }
      } catch (error) {
        this.remoteError = error?.message || 'copilot_task_queue_unavailable';
        if (this.allowLocalFallback) {
          this.mode = 'local';
          this.logger.warn?.('[copilot-tasks] fallback local explicitamente habilitado; somente uma réplica pode consumir a fila.');
        } else {
          this.mode = 'unavailable';
          this.logger.error?.('[copilot-tasks] Supabase configurado, mas a fila não está disponível. Aplique a migration; execução bloqueada para evitar split-brain.');
        }
      }
    }
    this.loaded = true;
    return this.tasks;
  }

  async _saveLocal() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      const terminal = this.tasks.filter(task => ['succeeded', 'failed', 'uncertain', 'cancelled'].includes(task.status)).slice(-1000);
      const active = this.tasks.filter(task => !['succeeded', 'failed', 'uncertain', 'cancelled'].includes(task.status));
      await fs.writeFile(tmp, JSON.stringify([...terminal, ...active], null, 2), 'utf8');
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

  setOnEnqueue(fn) {
    this.onEnqueue = typeof fn === 'function' ? fn : null;
  }

  _notifyEnqueued(task) {
    if (!task?.created || typeof this.onEnqueue !== 'function') return;
    try { this.onEnqueue(task); } catch {}
  }

  async enqueue(input = {}) {
    if (!this.loaded) await this.load();
    if (this.mode === 'unavailable') throw new Error('copilot_task_queue_unavailable');
    if (!this.remoteEnabled && this.localCorrupt) throw new Error('copilot_task_local_store_corrupt');
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
      result_summary: {},
      last_error_code: null,
      attempt_count: 0,
      max_attempts: normalized.retryPolicy === 'read_only' ? 2 : 1,
      notification_status: 'pending',
      created_at: createdAt,
      updated_at: createdAt,
      available_at: createdAt,
      expires_at: new Date(this.now() + 6 * 60 * 60 * 1000).toISOString()
    };

    if (this.remoteEnabled) {
      try {
        const inserted = await this.client.request('copilot_tasks', {
          method: 'POST',
          body: [row],
          prefer: 'return=representation'
        });
        if (Array.isArray(inserted) && inserted[0]) {
          const result = { ...mapTask(inserted[0]), created: true };
          this._notifyEnqueued(result);
          return result;
        }
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
      const result = { ...clone(task), created: true };
      this._notifyEnqueued(result);
      return result;
    });
  }

  async claimNext(workerId, leaseSeconds = 180) {
    if (!this.loaded) await this.load();
    if (this.mode === 'unavailable' || (!this.remoteEnabled && this.localCorrupt)) return null;
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
        if (task.status === 'queued' && task.expiresAt && Date.parse(task.expiresAt) <= nowMs) {
          task.status = 'failed';
          task.errorCode = 'task_expired_before_execution';
          task.resultText = 'A tarefa expirou antes de começar. Nenhuma ferramenta foi executada.';
          task.completedAt = new Date(nowMs).toISOString();
          task.updatedAt = new Date(nowMs).toISOString();
        }
        if (task.status === 'running' && Date.parse(task.leaseExpiresAt || '') <= nowMs) {
          if (task.retryPolicy === 'read_only' && task.attemptCount < task.maxAttempts) {
            task.status = 'queued';
            task.errorCode = 'read_only_lease_expired';
          } else if (task.retryPolicy === 'read_only') {
            task.status = 'failed';
            task.errorCode = 'read_only_attempts_exhausted';
            task.resultText = 'A consulta foi interrompida após atingir o limite de tentativas seguras. Nenhuma ação externa foi repetida.';
            task.completedAt = new Date(nowMs).toISOString();
          } else {
            task.status = 'uncertain';
            task.errorCode = 'worker_lease_expired';
            task.resultText = 'A execução foi interrompida e o resultado ficou incerto. É necessária uma conferência antes de qualquer nova tentativa.';
            task.completedAt = new Date(nowMs).toISOString();
          }
          task.leaseOwner = null;
          task.leaseToken = null;
          task.leaseExpiresAt = null;
          task.updatedAt = new Date(nowMs).toISOString();
        }
        if (['succeeded', 'failed', 'uncertain'].includes(task.status) && task.notificationStatus === 'sending'
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

  async fail(task, errorCode = 'tool_execution_failed', resultText = '') {
    return this._patchRunning(task, {
      status: 'failed',
      result_text: String(resultText || 'A tarefa não foi concluída. Nenhuma repetição automática será feita.').slice(0, 16000),
      notification_status: 'pending',
      last_error_code: String(errorCode || 'tool_execution_failed').replace(/\d{7,}/g, '[redacted]').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 120),
      completed_at: new Date(this.now()).toISOString(),
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null
    });
  }

  async uncertain(task, errorCode = 'execution_result_uncertain', resultText = '') {
    return this._patchRunning(task, {
      status: 'uncertain',
      result_text: String(resultText || 'A execução ficou incerta. É necessária uma conferência antes de qualquer nova tentativa.').slice(0, 16000),
      notification_status: 'pending',
      last_error_code: String(errorCode || 'execution_result_uncertain').toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/\d{7,}/g, '[redacted]').slice(0, 120),
      completed_at: new Date(this.now()).toISOString(),
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null
    });
  }

  async claimPendingNotification() {
    if (!this.loaded) await this.load();
    if (this.mode === 'unavailable' || (!this.remoteEnabled && this.localCorrupt)) return null;
    if (this.remoteEnabled) {
      const rows = await this.client.select('copilot_tasks', 'select=*&status=in.(succeeded,failed,uncertain)&notification_status=eq.pending&order=completed_at.asc&limit=10');
      for (const row of Array.isArray(rows) ? rows : []) {
        const claimed = await this.client.request('copilot_tasks', {
          method: 'PATCH',
          query: `id=eq.${encodeURIComponent(row.id)}&status=in.(succeeded,failed,uncertain)&notification_status=eq.pending`,
          body: { notification_status: 'sending', updated_at: new Date(this.now()).toISOString() },
          prefer: 'return=representation'
        });
        if (Array.isArray(claimed) && claimed[0]) return mapTask(claimed[0]);
      }
      return null;
    }
    return this._serial(async () => {
      const task = this.tasks
        .filter(item => ['succeeded', 'failed', 'uncertain'].includes(item.status) && item.notificationStatus === 'pending')
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
        query: `id=eq.${encodeURIComponent(task.id)}&status=in.(succeeded,failed,uncertain)&notification_status=eq.sending`,
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
      const current = this.tasks.find(item => item.id === task.id && ['succeeded', 'failed', 'uncertain'].includes(item.status) && item.notificationStatus === 'sending');
      if (!current) return false;
      current.notificationStatus = status;
      current.notifiedAt = status === 'sent' ? new Date(this.now()).toISOString() : null;
      current.errorCode = errorCode ? String(errorCode).slice(0, 120) : null;
      current.updatedAt = new Date(this.now()).toISOString();
      await this._saveLocal();
      return true;
    });
  }

  async recoverInterruptedOnStartup(currentWorkerId = '') {
    if (!this.loaded) await this.load();
    if (this.mode === 'unavailable' || (!this.remoteEnabled && this.localCorrupt)) {
      return { recovered: 0, requeued: 0, markedUncertain: 0 };
    }
    const nowIso = new Date(this.now()).toISOString();
    let requeued = 0;
    let markedUncertain = 0;

    if (this.remoteEnabled) {
      try {
        const rows = await this.client.select(
          'copilot_tasks',
          'select=*&status=eq.running&order=started_at.asc&limit=25'
        );
        for (const row of Array.isArray(rows) ? rows : []) {
          const task = mapTask(row);
          if (currentWorkerId && task.leaseOwner === currentWorkerId) continue;
          const canRequeue = task.retryPolicy === 'read_only' && task.attemptCount < task.maxAttempts;
          const patch = canRequeue
            ? {
                status: 'queued',
                last_error_code: 'requeued_after_restart',
                lease_owner: null,
                lease_token: null,
                lease_expires_at: null,
                updated_at: nowIso
              }
            : {
                status: 'uncertain',
                last_error_code: 'interrupted_by_restart',
                result_text: 'O serviço reiniciou enquanto esta tarefa estava em execução. O resultado ficou incerto — confira antes de repetir a ação.',
                notification_status: 'pending',
                completed_at: nowIso,
                lease_owner: null,
                lease_token: null,
                lease_expires_at: null,
                updated_at: nowIso
              };
          const updated = await this.client.request('copilot_tasks', {
            method: 'PATCH',
            query: `id=eq.${encodeURIComponent(task.id)}&status=eq.running`,
            body: patch,
            prefer: 'return=representation'
          });
          if (Array.isArray(updated) && updated.length === 1) {
            if (canRequeue) requeued += 1;
            else markedUncertain += 1;
          }
        }
      } catch (error) {
        this.logger.warn?.('[copilot-tasks] falha na recuperação de tarefas no startup:', error?.code || error?.message || 'recovery_error');
      }
      return { recovered: requeued + markedUncertain, requeued, markedUncertain };
    }

    return this._serial(async () => {
      let dirty = false;
      for (const task of this.tasks) {
        if (task.status !== 'running') continue;
        if (currentWorkerId && task.leaseOwner === currentWorkerId) continue;
        const canRequeue = task.retryPolicy === 'read_only' && task.attemptCount < task.maxAttempts;
        if (canRequeue) {
          task.status = 'queued';
          task.errorCode = 'requeued_after_restart';
          requeued += 1;
        } else {
          task.status = 'uncertain';
          task.errorCode = 'interrupted_by_restart';
          task.resultText = 'O serviço reiniciou enquanto esta tarefa estava em execução. O resultado ficou incerto — confira antes de repetir a ação.';
          task.notificationStatus = 'pending';
          task.completedAt = nowIso;
          markedUncertain += 1;
        }
        task.leaseOwner = null;
        task.leaseToken = null;
        task.leaseExpiresAt = null;
        task.updatedAt = nowIso;
        dirty = true;
      }
      if (dirty) await this._saveLocal();
      return { recovered: requeued + markedUncertain, requeued, markedUncertain };
    });
  }


  async listUncertain({ limit = 50 } = {}) {
    if (!this.loaded) await this.load();
    if (this.mode === 'unavailable') throw new Error('copilot_task_queue_unavailable');
    if (!this.remoteEnabled && this.localCorrupt) throw new Error('copilot_task_local_store_corrupt');
    const max = Math.max(1, Math.min(100, Number(limit) || 50));
    if (this.remoteEnabled) {
      const [executionRows, notificationRows] = await Promise.all([
        this.client.select('copilot_tasks', 'select=*&status=eq.uncertain&order=updated_at.desc&limit=' + max),
        this.client.select('copilot_tasks', 'select=*&status=in.(succeeded,failed)&notification_status=eq.uncertain&order=updated_at.desc&limit=' + max)
      ]);
      const merged = new Map();
      for (const row of [...(executionRows || []), ...(notificationRows || [])]) {
        const task = mapTask(row);
        if (task.id) merged.set(task.id, task);
      }
      return [...merged.values()]
        .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
        .slice(0, max);
    }
    return this._serial(async () => this.tasks
      .filter(task => task.status === 'uncertain' || (
        ['succeeded', 'failed'].includes(task.status) && task.notificationStatus === 'uncertain'
      ))
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .slice(0, max)
      .map(clone));
  }

  async reconcileUncertain(taskId, { decision, evidence, actor } = {}) {
    if (!this.loaded) await this.load();
    if (this.mode === 'unavailable') throw new Error('copilot_task_queue_unavailable');
    if (!this.remoteEnabled && this.localCorrupt) throw new Error('copilot_task_local_store_corrupt');

    const id = String(taskId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error('invalid_copilot_task_id');
    }
    const allowed = new Set([
      'confirmed_succeeded', 'confirmed_failed',
      'notification_confirmed_sent', 'notification_confirmed_not_sent', 'still_uncertain'
    ]);
    if (!allowed.has(decision)) throw new Error('invalid_reconciliation_decision');
    const note = String(evidence || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (note.length < 10) throw new Error('reconciliation_evidence_required');
    const actorLabel = String(actor || '').trim().slice(0, 120);
    if (!actorLabel) throw new Error('reconciliation_actor_required');
    const reconciliationNote = note
      .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
      .replace(/\b\d{8,15}\b/g, '[number]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .slice(0, 500);
    const nowIso = new Date(this.now()).toISOString();

    const applyDecision = current => {
      if (!current) return null;
      if (current.reconciledAt && current.reconciliationOutcome !== 'still_uncertain') throw new Error('copilot_task_already_reconciled');
      const executionUncertain = current.status === 'uncertain';
      const notificationUncertain = ['succeeded', 'failed'].includes(current.status)
        && current.notificationStatus === 'uncertain';
      if (!executionUncertain && !notificationUncertain) throw new Error('copilot_task_not_uncertain');
      if (executionUncertain && !['confirmed_succeeded', 'confirmed_failed', 'still_uncertain'].includes(decision)) {
        throw new Error('reconciliation_decision_mismatch');
      }
      if (notificationUncertain && !['notification_confirmed_sent', 'notification_confirmed_not_sent', 'still_uncertain'].includes(decision)) {
        throw new Error('reconciliation_decision_mismatch');
      }
      return {
        ...current,
        status: executionUncertain
          ? (decision === 'confirmed_succeeded' ? 'succeeded' : decision === 'confirmed_failed' ? 'failed' : 'uncertain')
          : current.status,
        // Never put a notification back in pending: reconciliation must not replay an external effect.
        notificationStatus: executionUncertain
          ? 'unaddressable'
          : (decision === 'notification_confirmed_sent' ? 'sent' : decision === 'notification_confirmed_not_sent' ? 'unaddressable' : 'uncertain'),
        reconciledAt: nowIso,
        reconciledBy: actorLabel,
        reconciliationOutcome: decision,
        reconciliationNote,
        updatedAt: nowIso,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null
      };
    };

    if (this.remoteEnabled) {
      const rows = await this.client.select('copilot_tasks', 'select=*&id=eq.' + encodeURIComponent(id) + '&limit=1');
      const current = Array.isArray(rows) && rows[0] ? mapTask(rows[0]) : null;
      if (!current) return null;
      const next = applyDecision(current);
      const reconciledCompare = current.reconciledAt
        ? '&reconciled_at=eq.' + encodeURIComponent(current.reconciledAt)
        : '&reconciled_at=is.null';
      const compare = 'id=eq.' + encodeURIComponent(id)
        + '&status=eq.' + encodeURIComponent(current.status)
        + '&notification_status=eq.' + encodeURIComponent(current.notificationStatus)
        + '&updated_at=eq.' + encodeURIComponent(current.updatedAt || '')
        + reconciledCompare;
      const updated = await this.client.request('copilot_tasks', {
        method: 'PATCH',
        query: compare,
        body: {
          status: next.status,
          notification_status: next.notificationStatus,
          reconciled_at: next.reconciledAt,
          reconciled_by: next.reconciledBy,
          reconciliation_outcome: next.reconciliationOutcome,
          reconciliation_note: next.reconciliationNote,
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
          updated_at: next.updatedAt
        },
        prefer: 'return=representation'
      });
      if (!Array.isArray(updated) || updated.length !== 1) throw new Error('copilot_task_reconciliation_conflict');
      return mapTask(updated[0]);
    }

    return this._serial(async () => {
      const current = this.tasks.find(task => task.id === id);
      if (!current) return null;
      const next = applyDecision(current);
      Object.assign(current, next);
      await this._saveLocal();
      return clone(current);
    });
  }

  async getById(taskId, ownerKey) {
    if (!this.loaded) await this.load();
    if (this.mode === 'unavailable') throw new Error('copilot_task_queue_unavailable');
    if (!this.remoteEnabled && this.localCorrupt) throw new Error('copilot_task_local_store_corrupt');
    const id = String(taskId || '').trim();
    const owner = String(ownerKey || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !owner) return null;
    if (this.remoteEnabled) {
      const rows = await this.client.select(
        'copilot_tasks',
        `select=*&id=eq.${encodeURIComponent(id)}&owner_key=eq.${encodeURIComponent(owner)}&limit=1`
      );
      return Array.isArray(rows) && rows[0] ? mapTask(rows[0]) : null;
    }
    return this._serial(async () => {
      const task = this.tasks.find(item => item.id === id && item.ownerKey === owner);
      return task ? clone(task) : null;
    });
  }

  async getLatest(ownerKey) {
    if (!this.loaded) await this.load();
    if (this.mode === 'unavailable') throw new Error('copilot_task_queue_unavailable');
    if (!this.remoteEnabled && this.localCorrupt) throw new Error('copilot_task_local_store_corrupt');
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
  if (task.status === 'succeeded' && task.notificationStatus === 'sent') return `A tarefa #${id} foi concluída e o resultado já foi enviado.${task.resultText ? `\n\n${task.resultText}` : ''}`;
  if (task.status === 'succeeded' && task.notificationStatus === 'uncertain') return `A tarefa #${id} foi concluída, mas não consegui confirmar a entrega da notificação. Não vou reenviar automaticamente para evitar duplicidade.${task.resultText ? `\n\nResultado:\n${task.resultText}` : ''}`;
  if (task.status === 'succeeded') return `A tarefa #${id} foi concluída e o resultado está pronto para entrega.${task.resultText ? `\n\n${task.resultText}` : ''}`;
  if (task.status === 'uncertain') return `${task.resultText || `A execução da tarefa #${id} ficou incerta.`} Interrompi novas tentativas para não duplicar uma ação. É necessária uma conferência antes de continuar.`;
  if (task.status === 'failed') return `${task.resultText || `A tarefa #${id} terminou sem conclusão (${task.errorCode || 'falha'}).`} ${task.notificationStatus === 'uncertain' ? 'Também não consegui confirmar a entrega desta notificação; não haverá reenvio automático.' : ''}`;
  if (task.status === 'cancelled') return `A tarefa #${id} foi cancelada.`;
  return `A tarefa #${id} terminou sem conclusão (${task.errorCode || task.status}). Nenhuma repetição automática será feita.`;
}
