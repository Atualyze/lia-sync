import crypto from 'node:crypto';
import { getToolExecutionPolicy, resolveToolName, validateToolCallArguments } from './tools/index.mjs';

export const COPILOT_TASK_STATES = Object.freeze([
  'queued', 'running', 'awaiting_input', 'succeeded', 'failed', 'uncertain', 'cancelled'
]);

const SAFE_READ_MODES = new Set(['read_only', 'read_only_untrusted_data']);
const isoNow = () => new Date().toISOString();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function isCopilotTaskStatusQuery(message = '') {
  const text = String(message || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  return /\b(?:onde esta|cade|estou esperando|ainda estou esperando|e a (?:pesquisa|consulta|tarefa|cobranca)|como esta (?:a|essa|aquela)? ?(?:tarefa|pesquisa|consulta)|status da tarefa|resultado da consulta|ja terminou|terminou a pesquisa)\b/i.test(text);
}

export function isUnstartedActionPromise(reply = '') {
  const text = String(reply || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const action = '(?:consultar|consultando|pesquisar|pesquisando|buscar|buscando|verificar|verificando|gerar|gerando|criar|criando|puxar|puxando|procurar|procurando)';
  if (new RegExp('\\b(?:vou|ja vou|estou|ja estou|aguarde|so um instante)\\b.{0,100}\\b' + action + '\\b', 'i').test(text)) return true;
  return /^\s*(?:entendido[.!]\s*)?(?:consultando|pesquisando|buscando|verificando|gerando|criando|puxando|procurando)\b/i.test(text);
}

export function resolveCopilotPaymentMethodChoice(message = '', lastAssistantMessage = '') {
  const normalizeText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const current = normalizeText(message);
  const previous = normalizeText(lastAssistantMessage);
  const asksPreference = /\b(?:prefere|preferia|qual|escolha|escolher|opcao|opcoes|deseja|quer)\b/.test(previous);
  const mentionsPixOption = /\b(?:pix|copia e cola|qr code)\b/.test(previous);
  const mentionsCheckoutOption = /\b(?:checkout|infinitepay|link de pagamento|cartao)\b/.test(previous);
  const separatesChoices = /\bou\b|\b(?:alternativa|opcao|opcoes)\b/.test(previous);
  if (!asksPreference || !mentionsPixOption || !mentionsCheckoutOption || !separatesChoices) return null;
  if (/^(?:direto|pix direto|pix copia e cola|copia e cola|qr code|qr)$/i.test(current)
    || /\b(?:quero|prefiro|manda|gere|gera|faz|faca)\s+(?:o\s+)?(?:pix\s+)?(?:direto|copia e cola|qr code)\b/.test(current)) return 'pix';
  if (/^(?:checkout|link|infinitepay|pix e cartao|cartao)$/i.test(current)
    || /\b(?:checkout|link infinitepay|pix e cartao)\b/.test(current)) return 'checkout';
  return null;
}
export function isBackgroundCopilotStep(step = {}) {
  const name = resolveToolName(step.name);
  const args = step.args && typeof step.args === 'object' && !Array.isArray(step.args) ? step.args : {};
  const mode = getToolExecutionPolicy(name).mode;

  if (SAFE_READ_MODES.has(mode)) return true;
  if (name === 'gerar_cobranca_pix') {
    const hasExplicitAmount = Object.prototype.hasOwnProperty.call(args, 'valor')
      && typeof args.valor === 'number'
      && Number.isFinite(args.valor)
      && args.valor >= 0;
    const hasDescription = typeof args.descricao === 'string'
      && args.descricao.trim().length >= 2
      && args.descricao.trim().length <= 80;
    return hasExplicitAmount && hasDescription;
  }
  if (name === 'checkout_infinitepay') {
    const hasStableOrderReference = ['orderNsu', 'transactionNsu', 'slug']
      .some(key => String(args[key] || '').trim().length > 0);
    return String(args.acao || '').toLowerCase() === 'verificar_pagamento' && hasStableOrderReference;
  }
  if (name === 'gerenciar_agenda_google') return ['consultar_livres', 'listar_eventos'].includes(String(args.action || ''));
  if (name === 'consultar_planilha_google') return ['ler_intervalo', 'buscar_linhas'].includes(String(args.acao || ''));
  if (name === 'gerenciar_drive_google') return ['listar_arquivos', 'buscar_arquivo'].includes(String(args.acao || ''));
  return false;
}

export function inferCopilotTaskType(steps = []) {
  const names = (Array.isArray(steps) ? steps : []).map(step => resolveToolName(step?.name));
  if (names.some(name => ['gerar_cobranca_pix', 'checkout_infinitepay'].includes(name))) return 'payment';
  if (names.some(name => name === 'consultar_web')) return 'web';
  if (names.some(name => name === 'consultar_saude_infra')) return 'infra';
  if (names.some(name => name === 'consultar_contato_ou_lead')) return 'contact';
  if (names.some(name => name === 'consultar_base_conhecimento')) return 'knowledge';
  if (names.some(name => name === 'consultar_dados_brasil')) return 'public_data';
  if (names.some(name => name.includes('agenda'))) return 'agenda';
  if (names.some(name => name.includes('drive'))) return 'drive';
  if (names.some(name => name.includes('planilha'))) return 'sheet';
  return 'general';
}

export function prepareCopilotTaskSteps(steps = [], taskId = '') {
  const stableTxid = 'LIA' + sha256(taskId).slice(0, 22).toUpperCase();
  return (Array.isArray(steps) ? steps : []).map((step, index) => {
    const name = resolveToolName(step?.name);
    const args = step?.args && typeof step.args === 'object' && !Array.isArray(step.args)
      ? { ...step.args }
      : {};
    if (name === 'gerar_cobranca_pix') {
      args.txid = stableTxid;
      args.enviarWhatsApp = false;
    }
    return {
      index: index + 1,
      name,
      args,
      policy: step?.policy || getToolExecutionPolicy(name),
      recovery_mode: 'safe',
      state: 'pending'
    };
  });
}

export class CopilotTaskStore {
  constructor(client, { logger = console, workerId = String(process.pid) } = {}) {
    this.client = client;
    this.logger = logger;
    this.workerId = String(workerId).slice(0, 120);
    this.ready = false;
    this.lastError = null;
  }

  get enabled() {
    return Boolean(this.ready && this.client?.enabled);
  }

  async initialize() {
    if (!this.client?.enabled) {
      this.ready = false;
      this.lastError = 'supabase_not_configured';
      return false;
    }
    try {
      await this.client.select('copilot_tasks', 'select=id&limit=1');
      this.ready = true;
      this.lastError = null;
      return true;
    } catch (error) {
      this.ready = false;
      this.lastError = error?.message || 'copilot_task_schema_unavailable';
      this.logger.warn?.('[copilot-tasks] fila durável desativada; aplique a migration 20261120160000_copilot_tasks.sql: ' + this.lastError.slice(0, 180));
      return false;
    }
  }

  async enqueue({ messageId = '', requestText = '', taskType = '', steps = [], actorLabel = 'responsável' } = {}) {
    if (!this.enabled) throw new Error('copilot_task_store_unavailable');
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 4 || !steps.every(isBackgroundCopilotStep)) {
      throw new Error('copilot_task_plan_not_background_safe');
    }
    for (const step of steps) {
      const invalid = validateToolCallArguments(step.name, step.args || {});
      if (invalid) throw new Error('copilot_task_invalid_arguments');
    }

    const stableMessageId = String(messageId || '').trim();
    if (!stableMessageId) throw new Error('copilot_task_message_id_required');
    const idempotencyKey = sha256('whatsapp:' + stableMessageId);
    const id = crypto.randomUUID();
    const preparedSteps = prepareCopilotTaskSteps(steps, id);
    const timestamp = isoNow();
    const row = {
      id,
      idempotency_key: idempotencyKey,
      actor_role: 'owner',
      actor_label: String(actorLabel || 'responsável').slice(0, 80),
      task_type: String(taskType || inferCopilotTaskType(steps)).slice(0, 40),
      request_text: String(requestText || '').slice(0, 2000),
      steps: preparedSteps,
      current_step: 0,
      status: 'queued',
      delivery_status: 'pending',
      created_at: timestamp,
      updated_at: timestamp
    };

    let inserted = null;
    let insertError = null;
    try {
      inserted = await this.client.request('copilot_tasks', {
        method: 'POST',
        query: 'on_conflict=idempotency_key',
        body: [row],
        prefer: 'resolution=ignore-duplicates,return=representation'
      });
    } catch (error) {
      insertError = error;
    }
    if (Array.isArray(inserted) && inserted[0]) return { ...inserted[0], duplicate: false };

    // A PostgREST timeout can happen after the insert committed. Check the
    // idempotency key before surfacing an error or letting a caller retry.
    const existing = await this.client.select(
      'copilot_tasks',
      'select=*&idempotency_key=eq.' + encodeURIComponent(idempotencyKey) + '&limit=1'
    );
    if (!existing?.[0]) {
      if (insertError) throw insertError;
      throw new Error('copilot_task_insert_not_confirmed');
    }
    return { ...existing[0], duplicate: true };
  }

  async claimNext(workerId = this.workerId, leaseSeconds = 90) {
    if (!this.enabled) return null;
    const claimed = await this.client.rpc('claim_copilot_task', {
      p_worker: String(workerId || this.workerId).slice(0, 120),
      p_lease_seconds: Math.max(60, Math.min(300, Number(leaseSeconds) || 90))
    });
    return Array.isArray(claimed) ? (claimed[0] || null) : (claimed || null);
  }

  async renewLease(taskId, leaseToken, leaseSeconds = 90) {
    if (!this.enabled || !taskId || !leaseToken) return false;
    return (await this.client.rpc('renew_copilot_task_lease', {
      p_task_id: taskId,
      p_lease_token: leaseToken,
      p_lease_seconds: Math.max(60, Math.min(300, Number(leaseSeconds) || 90))
    })) === true;
  }

  async checkpointStep(taskId, leaseToken, stepIndex, state, { result = null, error = '' } = {}) {
    if (!this.enabled) return false;
    return (await this.client.rpc('checkpoint_copilot_task_step', {
      p_task_id: taskId,
      p_lease_token: leaseToken,
      p_step_index: stepIndex,
      p_state: state,
      p_result: result,
      p_error: String(error || '').slice(0, 500)
    })) === true;
  }

  async finish(taskId, leaseToken, status, { result = null, error = '' } = {}) {
    if (!this.enabled) return false;
    return (await this.client.rpc('finish_copilot_task', {
      p_task_id: taskId,
      p_lease_token: leaseToken,
      p_status: status,
      p_result: result,
      p_error: String(error || '').slice(0, 500)
    })) === true;
  }

  async cancel(taskId) {
    if (!this.enabled || !taskId) return false;
    return (await this.client.rpc('cancel_copilot_task', { p_task_id: taskId })) === true;
  }

  async beginDelivery(taskId) {
    if (!this.enabled) return false;
    return (await this.client.rpc('begin_copilot_task_delivery', { p_task_id: taskId })) === true;
  }

  async finishDelivery(taskId, status, error = '') {
    if (!this.enabled) return false;
    return (await this.client.rpc('finish_copilot_task_delivery', {
      p_task_id: taskId,
      p_status: status,
      p_error: String(error || '').slice(0, 300)
    })) === true;
  }

  async getTask(taskId) {
    if (!this.enabled || !taskId) return null;
    const rows = await this.client.select('copilot_tasks', 'select=*&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    return rows?.[0] || null;
  }

  async pendingDelivery() {
    if (!this.enabled) return null;
    const rows = await this.client.select(
      'copilot_tasks',
      'select=*&delivery_status=eq.pending&status=in.(succeeded,failed,awaiting_input,uncertain)&order=created_at.asc&limit=1'
    );
    return rows?.[0] || null;
  }

  async latest({ limit = 5 } = {}) {
    if (!this.enabled) return [];
    return await this.client.select(
      'copilot_tasks',
      'select=*&actor_role=eq.owner&order=created_at.desc&limit=' + Math.max(1, Math.min(10, limit))
    ) || [];
  }
}

export function describeCopilotTaskStatus(task = {}) {
  const id = String(task.id || '').split('-')[0].toUpperCase() || 'sem ID';
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const current = Math.max(0, Number(task.current_step) || 0);
  const state = task.status || 'unknown';
  const base = 'Tarefa ' + id;
  if (state === 'queued') return base + ': registrada e aguardando execução (' + steps.length + ' etapa(s)).';
  if (state === 'running') return base + ': em execução, etapa ' + Math.max(1, Math.min(current || 1, steps.length)) + ' de ' + steps.length + '.';
  if (state === 'awaiting_input') return base + ': pausada aguardando uma confirmação ou informação.';
  if (state === 'succeeded') {
    const delivery = task.delivery_status === 'sent'
      ? 'O resultado já foi enviado.'
      : task.delivery_status === 'uncertain'
        ? 'A entrega da resposta ficou incerta; não será repetida automaticamente.'
        : 'O resultado está salvo e disponível nesta conversa.';
    return base + ': concluída. ' + delivery;
  }
  if (state === 'failed') return base + ': falhou. ' + String(task.last_error || 'Consulte o erro registrado.').slice(0, 220);
  if (state === 'uncertain') return base + ': estado incerto. Precisa de conferência antes de qualquer nova tentativa.';
  if (state === 'cancelled') return base + ': cancelada.';
  return base + ': estado ' + state + '.';
}
