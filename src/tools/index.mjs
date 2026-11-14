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
import { toolGerarCobrancaPix } from './gerar_cobranca_pix.mjs';
import { toolCheckoutInfinitePay } from './checkout_infinitepay.mjs';

export const TOOL_SETTINGS_SCHEMA = {
  gerar_cobranca_pix: [
    { key: 'key', label: 'Chave Pix', type: 'text', placeholder: 'CPF/CNPJ, e-mail, telefone ou chave aleatória' },
    { key: 'keyType', label: 'Tipo da Chave Pix', type: 'text', placeholder: 'auto (ou telefone, cpf, cnpj, email, aleatoria)' },
    { key: 'merchantName', label: 'Nome do Favorecido', type: 'text', placeholder: 'Ex.: Atualyze Clínica (até 25 chars)' },
    { key: 'merchantCity', label: 'Cidade', type: 'text', placeholder: 'Ex.: SAO PAULO (até 15 chars)' },
    { key: 'publicBaseUrl', label: 'URL Pública (para link /pix)', type: 'text', placeholder: 'Ex.: https://seu-dominio.com' }
  ],
  checkout_infinitepay: [
    { key: 'handle', label: 'InfiniteTag (Handle)', type: 'text', placeholder: 'Ex.: tauanpires (sem $)' },
    { key: 'apiKey', label: 'API Key (opcional)', type: 'password', placeholder: 'Chave para opções avançadas do Checkout' },
    { key: 'publicBaseUrl', label: 'URL Pública (para webhook automático)', type: 'text', placeholder: 'Ex.: https://liasync.atualyze.com.br' },
    { key: 'redirectUrl', label: 'URL de Redirecionamento (opcional)', type: 'text', placeholder: 'Ex.: https://seusite.com/obrigado' }
  ],
  consultar_planilha_google: [
    { key: 'defaultSpreadsheetId', label: 'ID da Planilha Padrão', type: 'text', placeholder: 'ID da URL do Google Sheets' },
    { key: 'defaultRange', label: 'Intervalo Padrão', type: 'text', placeholder: 'Ex.: A1:Z100' }
  ],
  gerenciar_drive_google: [
    { key: 'defaultFolderId', label: 'ID da Pasta Padrão', type: 'text', placeholder: 'ID da pasta no Google Drive' }
  ],
  gerenciar_agenda_google: [
    { key: 'calendarId', label: 'ID da Agenda', type: 'text', placeholder: 'primary ou e-mail da agenda' }
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
  toolGerarCobrancaPix,
  toolCheckoutInfinitePay
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
  consultar_cep_cnpj: 'consultar_dados_brasil',
  gerar_pix: 'gerar_cobranca_pix'
};

export function resolveToolName(toolName) {
  return TOOL_NAME_ALIASES[toolName] || toolName;
}

const CLIENT_ALLOWED_TOOL_NAMES = new Set([
  'agendar_retorno_ou_followup',
  'consultar_base_conhecimento',
  'consultar_web',
  'consultar_planilha_google',
  'gerenciar_drive_google',
  'consultar_dados_brasil',
  'gerar_cobranca_pix',
  'checkout_infinitepay'
]);
export const isClientToolAllowed = (toolName) => CLIENT_ALLOWED_TOOL_NAMES.has(resolveToolName(toolName));

export function isToolEnabled(toolName, botConfig = {}) {
  const canonical = resolveToolName(toolName);
  if (canonical === 'consultar_web' && botConfig?.webSearch?.enabled === false) return false;
  return botConfig?.tools?.enabled?.[canonical] !== false && botConfig?.tools?.enabled?.[toolName] !== false;
}

export function getEnabledTools(botConfig = {}, { actor = 'owner' } = {}) {
  return ALL_TOOLS.filter(tool => isToolEnabled(tool.name, botConfig) && (actor !== 'client' || CLIENT_ALLOWED_TOOL_NAMES.has(tool.name)));
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
  toolConsultarDadosBrasil,
  toolGerarCobrancaPix
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

function validateToolArguments(tool, args) {
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

/**
 * Executa uma ferramenta pelo nome com os argumentos passados
 */
export async function executeToolCall(toolName, args = {}, context = {}) {
  const canonicalName = resolveToolName(toolName);
  if (!isToolEnabled(canonicalName, context.botConfig || {})) {
    return { error: `A ferramenta "${canonicalName}" está desativada na configuração publicada.` };
  }
  if (context.actor === 'client' && !CLIENT_ALLOWED_TOOL_NAMES.has(canonicalName)) {
    return { error: 'Ferramenta indisponível neste fluxo.' };
  }
  const tool = ALL_TOOLS.find(t => t.name === canonicalName);
  if (!tool) {
    return { error: 'Ferramenta "' + toolName + '" não encontrada.' };
  }
  const invalid = validateToolArguments(tool, args);
  if (invalid) return { success: false, error: invalid, code: 'invalid_tool_arguments' };
  try {
    return await tool.execute(args, context);
  } catch (err) {
    return { error: 'Falha ao executar ' + canonicalName + ': ' + err.message };
  }
}
