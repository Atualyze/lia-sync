import { executeToolCall, validateToolCallArguments } from './tools/index.mjs';
import { verifyCopilotToolResult } from './flow/copilot-tool-plan.mjs';
import { isBackgroundCopilotStep } from './copilot-tasks.mjs';
import { filterReply } from './safety.mjs';
import { formatOutgoingMessage } from './core/format.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';

function compactValue(value, depth = 0) {
  if (depth > 7) return '[truncated]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 12000 ? value.slice(0, 12000) + '…[truncated]' : value;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => compactValue(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    if (/^(?:qrCodeDataUrl|base64|audioBase64|imageBase64|rawPayload)$/i.test(key)) continue;
    out[key] = compactValue(item, depth + 1);
  }
  return out;
}

function fallbackReply(requestText, outputs = []) {
  const pix = outputs.find(item => item.tool === 'gerar_cobranca_pix' && item.result?.success);
  if (pix) {
    const result = pix.result;
    const amount = result.valor
      ? 'R$ ' + Number(result.valor).toFixed(2).replace('.', ',')
      : 'Valor livre';
    const fence = String.fromCharCode(96).repeat(3);
    return [
      '💳 *Cobrança Pix gerada e verificada:*',
      '• *Valor:* ' + amount,
      '• *Favorecido:* ' + (result.favorecido || 'não informado'),
      result.paymentUrl ? '• *Link de pagamento:* ' + result.paymentUrl : '',
      result.pixCopiaECola ? '• *Copia e Cola:*\n' + fence + result.pixCopiaECola + fence : ''
    ].filter(Boolean).join('\n\n');
  }

  const web = outputs.find(item => item.tool === 'consultar_web');
  if (web?.result?.success) {
    const sources = (web.result.sources || []).slice(0, 8)
      .map(source => '- ' + (source.title || source.uri) + ': ' + source.uri).join('\n');
    return [
      '🔎 *Pesquisa concluída:*',
      String(web.result.text || web.result.summary || 'A consulta não retornou texto legível.').slice(0, 9000),
      sources ? '*Fontes:*\n' + sources : ''
    ].filter(Boolean).join('\n\n');
  }

  const pieces = outputs.map(item => {
    const value = item.result || {};
    if (item.error) return '• *' + item.tool + ':* falhou — ' + item.error;
    return '• *' + item.tool + ':* ' + (value.message || value.summary || JSON.stringify(value).slice(0, 1800));
  });
  return 'Resultado da tarefa solicitada:\n\n' + (pieces.join('\n') || 'Nenhum resultado foi retornado.') +
    (requestText ? '\n\n_Pedido original: ' + String(requestText).slice(0, 500) + '_' : '');
}

async function buildFinalReply({ ai, task, outputs, botConfig }) {
  if (!outputs.length) return 'A tarefa foi encerrada sem resultados executáveis. Não considerei a solicitação concluída.';
  // Pix Copia e Cola é um artefato exato: não o reescrever nem resumir com IA.
  if (outputs.some(item => item.tool === 'gerar_cobranca_pix')) return fallbackReply(task.request_text, outputs);
  if (ai?.askAI) {
    try {
      const result = await ai.askAI({
        system: [
          'Você é a camada final de resposta do Copiloto.',
          'Os resultados abaixo vieram de ferramentas realmente executadas. Não execute ferramentas, não invente dados e não transforme estados failed, unverified ou awaiting_confirmation em sucesso.',
          'Responda em português brasileiro, de forma clara e direta, entregando os dados úteis e links recebidos.',
          'Para Pix, preserve integralmente o código Copia e Cola e o link de pagamento. Não diga que foi enviado por WhatsApp; informe apenas o que o resultado comprova.',
          'Se uma consulta não encontrou dados, diga isso explicitamente. Nunca invente fontes.'
        ].join('\n'),
        history: [],
        userText: JSON.stringify({
          request: String(task.request_text || '').slice(0, 2000),
          results: outputs.map(item => ({
            tool: item.tool,
            verification: item.verification,
            result: compactValue(item.result),
            error: item.error
          }))
        }),
        botConfig,
        isOwner: true,
        autoRouting: false,
        disableToolCalling: true,
        deadline: Date.now() + 35000
      });
      const reply = String(result?.reply || result?.text || '').trim();
      if (reply) return reply;
    } catch {}
  }
  return fallbackReply(task.request_text, outputs);
}

function isTransientError(value = '') {
  return /timeout|timed out|temporar|http\s*(?:429|500|502|503|504)|\b(?:429|500|502|503|504)\b|econnreset|enotfound|network|fetch failed/i.test(String(value));
}

export function createCopilotTaskRunner({
  taskStore,
  sessionStore,
  ai,
  whatsapp = {},
  getBotConfig = () => ({}),
  getHumanPhone = () => '',
  reminderStore = null,
  adminConfig = null,
  operationsStore = null,
  logger = console,
  workerId = String(process.pid),
  executeToolCallImpl = executeToolCall,
  verifyToolResultImpl = verifyCopilotToolResult
} = {}) {
  let running = false;
  let activePromise = null;
  let stopped = false;

  const audit = async (action, task, status) => {
    try {
      await operationsStore?.audit?.({
        action,
        entityType: 'copilot_task',
        entityId: task?.id || null,
        metadata: {
          source: 'copilot_task_queue',
          actorRole: 'owner',
          actorLabel: task?.actor_label || 'responsável',
          status: String(status || '').slice(0, 80),
          reasonCode: task?.task_type || ''
        }
      });
    } catch {
      // A auditoria nunca pode provocar repetição de uma ferramenta ou entrega.
    }
  };

  const recordInternalHistory = async (reply, task) => {
    if (!sessionStore?.get) return;
    try {
      const session = sessionStore.get(OWNER_SELF_KEY);
      session.history ??= [];
      const alreadyRecorded = session.history.some(item => item?.taskId === task.id);
      if (!alreadyRecorded) {
        session.history.push({
          role: 'assistant',
          content: reply,
          createdAt: new Date().toISOString(),
          taskId: task.id
        });
      }
      if (session.history.length > 100) session.history = session.history.slice(-80);
      session.lastBotAt = new Date().toISOString();
      session.updatedAt = new Date().toISOString();
      if (task.task_type === 'payment' && task.status === 'succeeded') session.pendingPixRequest = null;
      const pending = session.pendingCopilotTask;
      if (pending && (
        pending.taskId === task.id
        || (!pending.taskId && String(pending.originCommand || '') === String(task.request_text || ''))
      )) {
        session.pendingCopilotTask = null;
      }
      sessionStore.markDirty();
      await sessionStore.flush?.();
    } catch (error) {
      logger.warn?.('[copilot-tasks] resultado salvo na fila, mas o histórico da sessão não foi atualizado: ' + String(error?.message || 'persist_failed').slice(0, 120));
    }
  };

  const deliver = async (task, reply) => {
    const claimed = await taskStore.beginDelivery(task.id);
    if (!claimed) return 'not_claimed';
    const target = String(getHumanPhone() || '').replace(/\D/g, '');
    if (!target || target.length < 8) {
      await taskStore.finishDelivery(task.id, 'skipped', 'Destino interno não configurado; consulte a tarefa pelo Copiloto.');
      return 'skipped';
    }

    try {
      const filtered = filterReply(reply, { isCopilot: true });
      if (!filtered.text) throw new Error('empty_filtered_reply');
      await whatsapp.sendText(target, formatOutgoingMessage(filtered.text));
      await taskStore.finishDelivery(task.id, 'sent');
      return 'sent';
    } catch (error) {
      await taskStore.finishDelivery(task.id, 'uncertain', String(error?.message || 'whatsapp_delivery_unknown'));
      logger.error?.('[copilot-tasks] entrega com resultado incerto; sem retry automático (' + String(error?.name || 'Error') + ')');
      return 'uncertain';
    }
  };

  const executeTask = async task => {
    const token = task.lease_token;
    const steps = Array.isArray(task.steps) ? task.steps : [];
    const outputs = [];
    const botConfig = getBotConfig() || {};
    let heartbeatLost = false;
    const heartbeat = setInterval(() => {
      void taskStore.renewLease(task.id, token).then(ok => {
        if (!ok) heartbeatLost = true;
      }).catch(() => { heartbeatLost = true; });
    }, 20000);
    heartbeat.unref?.();

    try {
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index] || {};
        const name = String(step.name || '');
        const invalidArguments = validateToolCallArguments(name, step.args || {});
        if (!isBackgroundCopilotStep(step) || invalidArguments) {
          const safeError = !isBackgroundCopilotStep(step)
            ? 'A etapa deixou de pertencer à allowlist de execução em segundo plano.'
            : 'Os argumentos da etapa não passaram pela validação atual do catálogo.';
          const verification = { state: 'failed', continue: false, recovery: 'stop_and_report' };
          outputs.push({ tool: name || 'unknown', error: safeError, verification });
          const checkpointed = await taskStore.checkpointStep(task.id, token, index + 1, 'failed', {
            result: { verification },
            error: safeError
          });
          if (!checkpointed) throw new Error('copilot_task_lease_lost_before_invalid_step_checkpoint');
          const reply = await buildFinalReply({ ai, task, outputs, botConfig });
          const persisted = await taskStore.finish(task.id, token, 'failed', {
            result: { outputs, reply },
            error: safeError
          });
          if (!persisted) throw new Error('copilot_task_finish_not_confirmed_after_validation_failure');
          const failedTask = { ...task, status: 'failed' };
          await recordInternalHistory(reply, failedTask);
          await audit('copilot_task_finished', task, 'failed');
          await deliver(failedTask, reply);
          return;
        }
        if (step.state === 'succeeded' && step.result) {
          outputs.push({
            tool: name,
            result: step.result.result || step.result,
            verification: step.result.verification || { state: 'verified', continue: true }
          });
          continue;
        }
        if (heartbeatLost) throw new Error('copilot_task_lease_lost');
        const checkpointed = await taskStore.checkpointStep(task.id, token, index + 1, 'running');
        if (!checkpointed) throw new Error('copilot_task_lease_lost');

        const context = {
          phone: OWNER_SELF_KEY,
          actor: 'owner',
          isOwner: true,
          clientName: String(task.actor_label || 'responsável') + ' (Copiloto)',
          botConfig,
          adminConfig,
          store: sessionStore,
          session: sessionStore?.get?.(OWNER_SELF_KEY),
          reminderStore,
          whatsapp,
          ai,
          operationsStore,
          userText: String(task.request_text || ''),
          auditActorLabel: String(task.actor_label || 'responsável').slice(0, 80),
          searchWebWithGemini: ai?.searchWebWithGemini,
          planStep: index + 1
        };

        const result = await executeToolCallImpl(name, step.args || {}, context);
        const verification = verifyToolResultImpl(name, result);
        const safeResult = compactValue(result);
        outputs.push({ tool: name, result: safeResult, verification });

        if (!verification.continue) {
          const terminalStepState = verification.state === 'awaiting_confirmation'
            ? 'awaiting_input'
            : verification.state === 'unverified'
              ? 'uncertain'
              : 'failed';
          await taskStore.checkpointStep(task.id, token, index + 1, terminalStepState, {
            result: { result: safeResult, verification },
            error: result?.error || result?.message || verification.state
          });
          const reply = await buildFinalReply({ ai, task, outputs, botConfig });
          await taskStore.finish(task.id, token, terminalStepState, {
            result: { outputs, reply },
            error: result?.error || result?.message || verification.state
          });
          const updatedTask = { ...task, status: terminalStepState };
          await recordInternalHistory(reply, updatedTask);
          await audit('copilot_task_finished', task, terminalStepState);
          await deliver({ ...task, status: terminalStepState }, reply);
          return;
        }

        const saved = await taskStore.checkpointStep(task.id, token, index + 1, 'succeeded', {
          result: { result: safeResult, verification }
        });
        if (!saved) throw new Error('copilot_task_lease_lost_after_tool');
      }

      const reply = await buildFinalReply({ ai, task, outputs, botConfig });
      const persisted = await taskStore.finish(task.id, token, 'succeeded', {
        result: { outputs, reply }
      });
      if (!persisted) throw new Error('copilot_task_finish_not_confirmed');
      const completedTask = { ...task, status: 'succeeded' };
      await recordInternalHistory(reply, completedTask);
      await audit('copilot_task_finished', task, 'succeeded');
      await deliver(completedTask, reply);
    } catch (error) {
      const safeError = String(error?.message || 'copilot_task_worker_failed').slice(0, 300);
      if (!heartbeatLost && token) {
        const status = isTransientError(safeError) ? 'failed' : 'uncertain';
        const finalized = await taskStore.finish(task.id, token, status, {
          result: { outputs },
          error: safeError
        }).catch(() => false);
        if (finalized) await audit('copilot_task_finished', task, status);
      }
      logger.error?.('[copilot-tasks] execução interrompida (' + String(error?.name || 'Error') + ')');
    } finally {
      clearInterval(heartbeat);
    }
  };

  async function tick() {
    if (stopped || running || !taskStore?.enabled) return false;
    running = true;
    activePromise = (async () => {
      const pending = await taskStore.pendingDelivery?.();
      if (pending) {
        const reply = String(pending.result?.reply || await buildFinalReply({
          ai,
          task: pending,
          outputs: Array.isArray(pending.result?.outputs) ? pending.result.outputs : [],
          botConfig: getBotConfig() || {}
        })).trim();
        if (reply) {
          await recordInternalHistory(reply, pending);
          await deliver(pending, reply);
          return true;
        }
        await taskStore.finishDelivery(pending.id, 'skipped', 'A tarefa não possui resposta recuperável.');
      }

      const task = await taskStore.claimNext(workerId);
      if (!task) return false;
      await audit('copilot_task_started', task, 'running');
      await executeTask(task);
      return true;
    })();
    try {
      return await activePromise;
    } catch (error) {
      logger.error?.('[copilot-tasks] tick falhou: ' + String(error?.name || 'Error'));
      return false;
    } finally {
      running = false;
      activePromise = null;
    }
  }

  async function stop() {
    stopped = true;
    if (activePromise) await activePromise.catch(() => {});
  }

  return { tick, stop, get running() { return running; }, get enabled() { return Boolean(taskStore?.enabled); } };
}
