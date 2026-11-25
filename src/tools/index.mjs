import { readGoogleCredentials } from './google_auth.mjs';
import { toolConsultarContato } from './consultar_contato.mjs';
import { toolAgendarRetorno } from './agendar_retorno.mjs';
import { toolTransferirSetor } from './transferir_setor.mjs';
import { toolConsultarBaseConhecimento } from './consultar_base_conhecimento.mjs';
import { toolAtualizarDadosCRM } from './atualizar_dados_crm.mjs';
import { toolEnviarMensagemContato } from './enviar_mensagem_contato.mjs';
import { toolConsultarSaudeInfra } from './consultar_saude_infra.mjs';
import { toolGerenciarAgendaGoogle } from './gerenciar_agenda_google.mjs';
import { toolGerarDocumentoPdf } from './gerar_documento_pdf.mjs';
import { toolConsultarWeb } from './consultar_web.mjs';
import { toolConsultarPlanilhaGoogle } from './consultar_planilha_google.mjs';
import { toolGerenciarDriveGoogle } from './gerenciar_drive_google.mjs';
import { toolConsultarDadosBrasil } from './consultar_dados_brasil.mjs';
import { toolGerenciarCobrancaPagamento } from './gerenciar_cobranca_pagamento.mjs';
import { toolGerenciarMemoria } from './gerenciar_memoria.mjs';
import { toolSalvarContato } from './salvar_contato.mjs';
import { toolGerenciarCodigo } from './gerenciar_codigo.mjs';
import { toolGerenciarConfiguracao } from './gerenciar_configuracao.mjs';
import { toolGerenciarTarefasAutonomas } from './gerenciar_tarefas_autonomas.mjs';
import { toolGerenciarGmailGoogle } from './gerenciar_gmail_google.mjs';

export const TOOL_SETTINGS_SCHEMA = {
  gerenciar_agenda_google: [
    { key: 'calendarId', label: 'ID da agenda Google', type: 'text', placeholder: 'ID publicado da agenda autorizada' }
  ],
  consultar_planilha_google: [
    { key: 'defaultSpreadsheetId', label: 'Planilha padrão', type: 'text', placeholder: 'ID publicado da planilha' },
    { key: 'defaultRange', label: 'Intervalo padrão', type: 'text', placeholder: 'Ex.: Leads!A:Z' }
  ],
  gerenciar_drive_google: [
    { key: 'defaultFolderId', label: 'Pasta padrão do Drive', type: 'text', placeholder: 'ID publicado da pasta' }
  ],
  gerenciar_cobranca_pagamento: [
    { key: 'pixKey', label: 'Chave Pix', type: 'text', placeholder: 'CPF/CNPJ, e-mail, telefone ou chave aleatória' },
    { key: 'pixKeyType', label: 'Tipo da Chave Pix', type: 'text', placeholder: 'auto (ou telefone, cpf, cnpj, email, aleatoria)' },
    { key: 'merchantName', label: 'Nome do Favorecido', type: 'text', placeholder: 'Ex.: Atualyze Clínica (até 25 chars)' },
    { key: 'merchantCity', label: 'Cidade', type: 'text', placeholder: 'Ex.: SAO PAULO (até 15 chars)' },
    { key: 'paymentBaseUrl', label: 'URL Pública da página de pagamento', type: 'text', placeholder: 'Ex.: https://seu-dominio.com' },
    { key: 'handle', label: 'InfiniteTag (Handle)', type: 'text', placeholder: 'Ex.: suaempresa (sem $)' },
    { key: 'apiKey', label: 'API Key (opcional)', type: 'password', placeholder: 'Chave para opções avançadas do Checkout' },
    { key: 'publicBaseUrl', label: 'URL Pública (para webhook automático)', type: 'text', placeholder: 'Ex.: https://liasync.atualyze.com.br' },
    { key: 'redirectUrl', label: 'URL de Redirecionamento (opcional)', type: 'text', placeholder: 'Ex.: https://seusite.com/obrigado' },
    { key: 'webhookSecret', label: 'Segredo do webhook', type: 'password', placeholder: 'Obrigatório para confirmação automática' }
  ]
};

export const ALL_TOOLS = [
  toolTransferirSetor,
  toolAgendarRetorno,
  toolConsultarContato,
  toolConsultarBaseConhecimento,
  toolAtualizarDadosCRM,
  toolEnviarMensagemContato,
  toolConsultarSaudeInfra,
  toolGerenciarAgendaGoogle,
  toolGerarDocumentoPdf,
  toolConsultarWeb,
  toolConsultarPlanilhaGoogle,
  toolGerenciarDriveGoogle,
  toolConsultarDadosBrasil,
  toolGerenciarCobrancaPagamento,
  toolGerenciarMemoria,
  toolSalvarContato,
  toolGerenciarCodigo,
  toolGerenciarConfiguracao,
  toolGerenciarTarefasAutonomas,
  toolGerenciarGmailGoogle
];

const TOOL_NAME_ALIASES = {
  agendar_retorno: 'agendar_retorno_ou_followup',
  consultar_contato: 'consultar_contato_ou_lead',
  pesquisar_web: 'consultar_web',
  google_agenda: 'gerenciar_agenda_google',
  gerar_pdf: 'gerar_documento_pdf',
  enviar_mensagem: 'enviar_mensagem_contato',
  google_sheets: 'consultar_planilha_google',
  google_drive: 'gerenciar_drive_google',
  google_gmail: 'gerenciar_gmail_google',
  gmail: 'gerenciar_gmail_google',
  consultar_cep_cnpj: 'consultar_dados_brasil',
};

export function resolveToolName(toolName) {
  return TOOL_NAME_ALIASES[toolName] || toolName;
}

const CLIENT_ALLOWED_TOOL_NAMES = new Set([
  'agendar_retorno_ou_followup',
  'gerenciar_agenda_google',
  'consultar_base_conhecimento',
  'consultar_web',
  'consultar_dados_brasil',
  'gerenciar_cobranca_pagamento',
  'gerenciar_memoria'
]);
export const isClientToolAllowed = (toolName) => CLIENT_ALLOWED_TOOL_NAMES.has(resolveToolName(toolName));

export function hasGoogleWorkspaceCredentials(envPrefix = 'GOOGLE') {
  const credentials = readGoogleCredentials(envPrefix);
  return Boolean(
    credentials.accessToken
    || (credentials.clientId && credentials.clientSecret && credentials.refreshToken)
    || (credentials.serviceAccountEmail && credentials.serviceAccountPrivateKey)
  );
}

export function isToolConfigured(toolName, botConfig = {}) {
  const canonical = resolveToolName(toolName);
  if (canonical === 'gerenciar_drive_google') {
    return hasGoogleWorkspaceCredentials('GOOGLE_DRIVE');
  }
  if (canonical === 'consultar_planilha_google') {
    return hasGoogleWorkspaceCredentials('GOOGLE_SHEETS');
  }
  if (canonical === 'gerenciar_gmail_google') {
    return hasGoogleWorkspaceCredentials('GOOGLE_GMAIL');
  }
  if (canonical === 'gerenciar_agenda_google') {
    const calendar = botConfig?.integrations?.googleCalendar || {};
    const calendarId = botConfig?.tools?.settings?.gerenciar_agenda_google?.calendarId || calendar.calendarId;
    return Boolean(calendar.enabled !== false && calendarId && (
      hasGoogleWorkspaceCredentials('GOOGLE_CALENDAR')
      || calendar.showMockSlotsWhenUnavailable === true
    ));
  }
  return true;
}

export function isToolEnabled(toolName, botConfig = {}) {
  const canonical = resolveToolName(toolName);
  if (canonical === 'consultar_web' && botConfig?.webSearch?.enabled === false) return false;
  if (canonical === 'gerenciar_cobranca_pagamento') {
    return botConfig?.tools?.enabled?.gerenciar_cobranca_pagamento === true;
  }
  return botConfig?.tools?.enabled?.[canonical] !== false && botConfig?.tools?.enabled?.[toolName] !== false;
}

export function getEnabledTools(botConfig = {}, { actor = 'owner' } = {}) {
  return ALL_TOOLS.filter(tool =>
    isToolEnabled(tool.name, botConfig)
    && isToolConfigured(tool.name, botConfig)
    && (actor !== 'client' || CLIENT_ALLOWED_TOOL_NAMES.has(tool.name))
  );
}

// Perfil de execução: descreve risco e política, mas não substitui as confirmações
// específicas já implementadas em cada fluxo/ferramenta.
export const TOOL_EXECUTION_POLICIES = Object.freeze({
  transferir_para_setor: { mode: 'internal_write', approval: 'explicit_intent', retry: 'never', effects: 'handoff' },
  agendar_retorno_ou_followup: { mode: 'scheduled_write', approval: 'explicit_intent', retry: 'never', effects: 'persistent_reminder' },
  consultar_contato_ou_lead: { mode: 'read_only', approval: 'none', retry: 'read_only_after_review', effects: 'crm_read' },
  consultar_base_conhecimento: { mode: 'read_only', approval: 'none', retry: 'read_only_after_review', effects: 'knowledge_read' },
  atualizar_dados_crm: { mode: 'crm_write', approval: 'explicit_intent', retry: 'never', effects: 'crm_update' },
  enviar_mensagem_contato: { mode: 'external_delivery', approval: 'explicit_confirmation', retry: 'never', effects: 'whatsapp_message' },
  consultar_saude_infra: { mode: 'read_only', approval: 'none', retry: 'read_only_after_review', effects: 'infrastructure_read' },
  gerenciar_agenda_google: { mode: 'conditional', approval: 'action_dependent', retry: 'never', effects: 'calendar_read_or_write' },
  gerar_documento_pdf: { mode: 'artifact_creation', approval: 'confirmation_before_delivery', retry: 'never', effects: 'pdf_creation' },
  consultar_web: { mode: 'read_only_untrusted_data', approval: 'none', retry: 'read_only_after_review', effects: 'external_web_read' },
  consultar_planilha_google: { mode: 'conditional', approval: 'action_dependent', retry: 'never', effects: 'sheets_read_or_write' },
  gerenciar_drive_google: { mode: 'conditional', approval: 'confirmation_before_delivery', retry: 'never', effects: 'drive_read_or_send' },
  consultar_dados_brasil: { mode: 'read_only', approval: 'none', retry: 'read_only_after_review', effects: 'public_data_read' },
  gerenciar_cobranca_pagamento: { mode: 'payment', approval: 'separate_payment_flow', retry: 'never', effects: 'pix_checkout_and_status' },
  gerenciar_memoria: { mode: 'memory_write', approval: 'explicit_intent', retry: 'never', effects: 'persistent_memory' },
  gerenciar_codigo: { mode: 'source_change_pr', approval: 'explicit_confirmation', retry: 'never', effects: 'github_branch_and_pr_only' },
  gerenciar_configuracao: { mode: 'configuration_write', approval: 'publish_confirmation', retry: 'never', effects: 'draft_or_publish_config' },
  gerenciar_tarefas_autonomas: { mode: 'internal_write', approval: 'explicit_intent', retry: 'never', effects: 'runtime_commitment_or_goal' },
  gerenciar_gmail_google: { mode: 'conditional', approval: 'draft_only_no_send', retry: 'never', effects: 'gmail_read_or_draft' }
});

export function getToolExecutionPolicy(toolName) {
  const canonicalName = resolveToolName(toolName);
  return TOOL_EXECUTION_POLICIES[canonicalName] || {
    mode: 'restricted',
    approval: 'unknown',
    retry: 'never',
    effects: 'unknown'
  };
}

/**
 * Catálogo vivo derivado de ALL_TOOLS. Parâmetros/obrigatoriedade vêm dos
 * JSON Schemas reais; disponibilidade é calculada por ator e configuração.
 * Ferramentas administrativas nunca aparecem no catálogo de clientes.
 */
export function getToolCatalog({ botConfig = {}, actor = 'owner', includeDisabled = true } = {}) {
  return ALL_TOOLS
    .filter(tool => actor !== 'client' || CLIENT_ALLOWED_TOOL_NAMES.has(tool.name))
    .map(tool => {
      const properties = tool.parameters?.properties || {};
      const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
      const enabled = isToolEnabled(tool.name, botConfig);
      const allowedForActor = actor !== 'client' || CLIENT_ALLOWED_TOOL_NAMES.has(tool.name);
      return {
        name: tool.name,
        aliases: Object.entries(TOOL_NAME_ALIASES)
          .filter(([, canonical]) => canonical === tool.name)
          .map(([alias]) => alias),
        description: tool.description || '',
        parameters: tool.parameters || { type: 'OBJECT', properties: {} },
        requiredParameters: [...required],
        optionalParameters: Object.keys(properties).filter(key => !required.includes(key)),
        enabled,
        allowedForActor,
        available: enabled && allowedForActor,
        policy: getToolExecutionPolicy(tool.name)
      };
    })
    .filter(item => includeDisabled || item.available);
}

export {
  toolConsultarContato,
  toolAgendarRetorno,
  toolTransferirSetor,
  toolConsultarBaseConhecimento,
  toolAtualizarDadosCRM,
  toolEnviarMensagemContato,
  toolConsultarSaudeInfra,
  toolGerenciarAgendaGoogle,
  toolGerarDocumentoPdf,
  toolConsultarWeb,
  toolConsultarPlanilhaGoogle,
  toolGerenciarDriveGoogle,
  toolGerenciarGmailGoogle,
  toolConsultarDadosBrasil,
  toolGerenciarCobrancaPagamento,
  toolSalvarContato
};

/**
 * Converte as ferramentas para o formato Gemini Function Declarations
 */
export function getGeminiToolDeclarations(tools = ALL_TOOLS) {
  return [
    {
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }))
    }
  ];
}

function stripForeignToolArguments(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const accepted = new Set(Object.keys(tool.parameters?.properties || {}));
  const declaredByOtherTools = new Set(ALL_TOOLS
    .filter(candidate => candidate.name !== tool.name)
    .flatMap(candidate => Object.keys(candidate.parameters?.properties || {})));
  return Object.fromEntries(Object.entries(args).filter(([key]) =>
    accepted.has(key) || !declaredByOtherTools.has(key)));
}

export function validateToolArguments(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Os argumentos da ferramenta precisam ser um objeto JSON.';
  const schema = tool.parameters || {};
  const properties = schema.properties || {};
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return `O argumento obrigatório "${key}" está ausente.`;
  }
  const types = { STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', OBJECT: 'object', ARRAY: 'array' };
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key] || {};
    const expected = String(property.type || '').toUpperCase();
    if (!expected) return `O argumento "${key}" não é aceito por esta ferramenta.`;
    if (Array.isArray(property.enum) && !property.enum.includes(value)) return `O argumento "${key}" precisa ser um dos valores permitidos.`;
    const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const valid = expected === 'INTEGER' ? Number.isInteger(value)
      : expected === 'NUMBER' ? typeof value === 'number' && Number.isFinite(value)
      : expected === 'OBJECT' ? actualType === 'object' && value !== null && !Array.isArray(value)
      : actualType === types[expected];
    if (!valid) return `O argumento "${key}" precisa ser do tipo ${expected.toLowerCase()}.`;
  }
  return null;
}

export function validateToolCallArguments(toolName, args = {}) {
  const canonicalName = resolveToolName(toolName);
  const tool = ALL_TOOLS.find(item => item.name === canonicalName);
  if (!tool) return 'Ferramenta não encontrada no catálogo.';
  const safeArgs = stripForeignToolArguments(tool, args);
  if (canonicalName === 'enviar_mensagem_contato' && !String(safeArgs?.message || '').trim()) {
    return validateToolArguments(tool, { ...safeArgs, message: '__PENDING_MESSAGE__' });
  }
  return validateToolArguments(tool, safeArgs);
}

function toolAuditStatus(result) {
  if (result?.requiresConfirmation === true) return 'awaiting_confirmation';
  if (result?.health !== undefined || Array.isArray(result?.checks)) {
    return result?.health === 'healthy' || result?.healthy === true ? 'diagnostic_completed' : 'completed_with_warnings';
  }
  if (result?.success === false || result?.error) return 'failed';
  if (result?.success === true) return 'completed';
  if (result?.found === true) return 'completed';
  if (result?.found === false) return 'completed_no_match';
  return 'unverified';
}

async function auditToolExecution(context, toolName, result, startedAt) {
  const operationsStore = context.operationsStore;
  if (typeof operationsStore?.audit !== 'function') return;
  const error = result?.error || result?.message || '';
  try {
    await operationsStore.audit({
      actorId: context.auditActorId || null,
      action: 'tool_execution',
      entityType: 'tool',
      metadata: {
        source: context.actor === 'client' ? 'client' : 'copilot',
        toolName,
        actorRole: context.actor || (context.isOwner === true ? 'owner' : 'system'),
        actorLabel: context.auditActorLabel || context.clientName || '',
        status: toolAuditStatus(result),
        durationMs: Math.max(0, Date.now() - startedAt),
        reasonCode: result?.code || (error ? 'tool_result_error' : '')
          || null,
        planStep: Number.isInteger(context.planStep) ? context.planStep : null
      }
    });
  } catch (auditError) {
    // Auditoria é best-effort: sua indisponibilidade nunca deve repetir ou
    // alterar uma ação externa que já foi executada.
    console.warn('[audit] execução de ferramenta não registrada (' + String(auditError?.code || 'audit_unavailable') + ')');
  }
}

/**
 * Executa uma ferramenta pelo nome com validação, política de ator e auditoria
 * sanitizada. A trilha não armazena argumentos, mensagens, telefones ou retorno.
 */
export async function executeToolCall(toolName, args = {}, context = {}) {
  const canonicalName = resolveToolName(toolName);
  const startedAt = Date.now();
  const finish = async result => {
    await auditToolExecution(context, canonicalName, result, startedAt);
    return result;
  };
  if (!isToolEnabled(canonicalName, context.botConfig || {})) {
    return finish({ success: false, code: 'tool_disabled', error: `A ferramenta "${canonicalName}" está desativada na configuração publicada.` });
  }
  if (context.actor === 'client' && !CLIENT_ALLOWED_TOOL_NAMES.has(canonicalName)) {
    return finish({ success: false, code: 'tool_not_allowed', error: 'Ferramenta indisponível neste fluxo.' });
  }
  const tool = ALL_TOOLS.find(t => t.name === canonicalName);
  if (!tool) {
    return finish({ success: false, code: 'tool_not_found', error: 'Ferramenta "' + toolName + '" não encontrada.' });
  }
  // Model calls can leak a parameter declared by a different tool (for example
  // `when` from scheduling into a Pix call). Remove only those known foreign
  // parameters; genuinely unknown arguments remain validation errors.
  const safeArgs = stripForeignToolArguments(tool, args);
  if (canonicalName === 'gerenciar_cobranca_pagamento' && typeof safeArgs?.valor === 'string') {
    const normalized = safeArgs.valor.trim().replace(/\s/g, '').replace(',', '.');
    if (/^\d+(?:\.\d+)?$/.test(normalized)) safeArgs.valor = Number(normalized);
  }
  const invalid = validateToolArguments(tool, safeArgs);
  if (invalid) return finish({ success: false, error: invalid, code: 'invalid_tool_arguments' });
  try {
    return await finish(await tool.execute(safeArgs, context));
  } catch (err) {
    return finish({ success: false, error: 'Falha ao executar ' + canonicalName + ': ' + err.message, code: 'tool_execution_failed' });
  }
}
