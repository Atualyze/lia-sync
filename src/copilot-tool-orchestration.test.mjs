import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_TOOLS, executeToolCall, getToolCatalog } from './tools/index.mjs';
import {
  buildCopilotToolPlan,
  getCopilotToolRecovery,
  MAX_COPILOT_TOOL_STEPS,
  verifyCopilotToolResult
} from './flow/copilot-tool-plan.mjs';
import { OperationsStore } from './operations.mjs';

test('catálogo dinâmico reflete todas as ferramentas reais e seus parâmetros', () => {
  const catalog = getToolCatalog({ actor: 'owner' });
  assert.equal(catalog.length, ALL_TOOLS.length);
  for (const tool of ALL_TOOLS) {
    const item = catalog.find(entry => entry.name === tool.name);
    assert.ok(item, 'ferramenta ausente: ' + tool.name);
    assert.deepEqual(item.parameters, tool.parameters);
    assert.deepEqual(item.requiredParameters, tool.parameters.required || []);
    assert.equal(typeof item.enabled, 'boolean');
    assert.ok(item.policy.mode);
  }
});

test('catálogo de cliente oculta ferramentas exclusivas do responsável e respeita ativação', () => {
  const clientCatalog = getToolCatalog({ actor: 'client' });
  assert.ok(clientCatalog.length > 0);
  assert.equal(clientCatalog.some(item => item.name === 'enviar_mensagem_contato'), false);
  assert.equal(clientCatalog.some(item => item.name === 'gerenciar_codigo'), false);
  assert.equal(clientCatalog.some(item => item.name === 'gerenciar_configuracao'), false);
  assert.equal(clientCatalog.some(item => item.name === 'atualizar_dados_crm'), false);

  const activeOnly = getToolCatalog({
    actor: 'owner',
    includeDisabled: false,
    botConfig: { tools: { enabled: { consultar_web: false } } }
  });
  assert.equal(activeOnly.some(item => item.name === 'consultar_web'), false);
});

test('planejador mantém a ordem, remove duplicatas e limita a sequência a quatro etapas', () => {
  const plan = buildCopilotToolPlan([
    { name: 'consultar_contato_ou_lead', args: { phone: '5588999999999' } },
    { name: 'consultar_base_conhecimento', args: { termo: 'política de atendimento' } },
    { name: 'consultar_saude_infra', args: {} },
    { name: 'consultar_web', args: { query: 'documentação oficial' } },
    { name: 'gerenciar_memoria', args: { acao: 'consultar' } }
  ]);
  assert.equal(plan.steps.length, MAX_COPILOT_TOOL_STEPS);
  assert.equal(plan.truncated, true);
  assert.equal(plan.canExecute, false);

  const deduped = buildCopilotToolPlan([
    { name: 'consultar_web', args: { query: 'Lia Sync' } },
    { name: 'consultar_web', args: { query: 'Lia Sync' } }
  ]);
  assert.equal(deduped.canExecute, true);
  assert.equal(deduped.steps.length, 1);
  assert.equal(deduped.duplicates.length, 1);
});

test('planejador permite coletar texto de envio depois da revisão, mas valida os demais campos', () => {
  const deferred = buildCopilotToolPlan([
    { name: 'enviar_mensagem_contato', args: { recipient: 'ptbr' } }
  ]);
  assert.equal(deferred.canExecute, true);
  assert.equal(deferred.steps[0].args.message, undefined);

  const invalidRecipient = buildCopilotToolPlan([
    { name: 'enviar_mensagem_contato', args: { recipient: 42 } }
  ]);
  assert.equal(invalidRecipient.canExecute, false);
  assert.equal(invalidRecipient.rejected[0].reason, 'invalid_arguments');
});

test('planejador bloqueia ferramentas desativadas e argumentos inválidos antes de executar', () => {
  const disabled = buildCopilotToolPlan(
    [{ name: 'consultar_web', args: { query: 'teste' } }],
    { botConfig: { tools: { enabled: { consultar_web: false } } } }
  );
  assert.equal(disabled.canExecute, false);
  assert.equal(disabled.rejected[0].reason, 'tool_disabled');

  const invalid = buildCopilotToolPlan([{ name: 'consultar_web', args: { query: 42 } }]);
  assert.equal(invalid.canExecute, false);
  assert.equal(invalid.rejected[0].reason, 'invalid_arguments');
});

test('verificação diferencia sucesso, ausência de contato, confirmação pendente e resultado incerto', () => {
  assert.equal(verifyCopilotToolResult('consultar_web', { success: true }).state, 'verified');
  assert.equal(verifyCopilotToolResult('consultar_contato_ou_lead', { found: false }).state, 'no_match');
  assert.equal(verifyCopilotToolResult('enviar_mensagem_contato', { success: false, requiresConfirmation: true }).state, 'awaiting_confirmation');
  assert.equal(verifyCopilotToolResult('consultar_web', { message: 'sem confirmação' }).state, 'unverified');
  assert.equal(verifyCopilotToolResult('consultar_saude_infra', { health: 'degraded', checks: [] }).continue, false);
});

test('recuperação recomenda revisão, mas nunca repete automaticamente operações', () => {
  const read = getCopilotToolRecovery('consultar_web', { error: 'HTTP 503 temporariamente indisponível' });
  assert.equal(read.action, 'retry_after_review');
  assert.equal(read.autoRetry, false);

  const send = getCopilotToolRecovery('enviar_mensagem_contato', { error: 'resultado incerto' });
  assert.equal(send.action, 'manual_check_before_retry');
  assert.equal(send.autoRetry, false);
});

test('execução de ferramenta registra auditoria sem argumentos ou conteúdo do resultado', async () => {
  const rows = [];
  const operationsStore = new OperationsStore({
    client: {
      enabled: true,
      async insert(table, values) { rows.push({ table, values }); }
    }
  });
  const secretText = 'TEXTO_SENSIVEL_QUE_NAO_DEVE_IR_PARA_AUDITORIA';
  const result = await executeToolCall('gerenciar_memoria', {
    acao: 'salvar',
    tipo: 'fact',
    conteudo: secretText
  }, {
    actor: 'owner',
    isOwner: true,
    auditActorLabel: 'Responsável',
    memoryStore: { remember: () => ({ saved: true, id: 'mem-1' }) },
    operationsStore,
    planStep: 2
  });

  assert.equal(result.success, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].table, 'audit_log');
  const metadata = rows[0].values[0].metadata;
  assert.equal(metadata.toolName, 'gerenciar_memoria');
  assert.equal(metadata.actorRole, 'owner');
  assert.equal(metadata.actorLabel, 'Responsável');
  assert.equal(metadata.status, 'completed');
  assert.equal(metadata.planStep, 2);
  assert.equal(JSON.stringify(metadata).includes(secretText), false);
});

test('metadados de auditoria aceitam identificação da ferramenta e continuam sanitizados', async () => {
  let inserted = null;
  const store = new OperationsStore({
    client: {
      enabled: true,
      async insert(_table, rows) { inserted = rows[0]; }
    }
  });
  await store.audit({
    action: 'tool_execution',
    entityType: 'tool',
    metadata: {
      toolName: 'consultar_contato_ou_lead',
      actorRole: 'client',
      actorLabel: 'Contato 5588999999999',
      status: 'completed',
      durationMs: 25,
      planStep: 1,
      phone: '5588999999999',
      message: 'não registrar conteúdo'
    }
  });
  assert.equal(inserted.metadata.toolName, 'consultar_contato_ou_lead');
  assert.equal(inserted.metadata.actorRole, 'client');
  assert.equal(inserted.metadata.durationMs, 25);
  assert.equal(inserted.metadata.planStep, 1);
  assert.equal(inserted.metadata.phone, undefined);
  assert.equal(inserted.metadata.message, undefined);
  assert.equal(inserted.metadata.actorLabel.includes('5588999999999'), false);
});
