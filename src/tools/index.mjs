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
  toolConsultarWeb
];

const TOOL_NAME_ALIASES = {
  agendar_retorno: 'agendar_retorno_ou_followup',
  consultar_contato: 'consultar_contato_ou_lead',
  pesquisar_web: 'consultar_web',
  google_agenda: 'gerenciar_agenda_google',
  gerar_pdf: 'gerar_documento_pdf',
  enviar_mensagem: 'enviar_mensagem_contato'
};

export function resolveToolName(toolName) {
  return TOOL_NAME_ALIASES[toolName] || toolName;
}

const CLIENT_ALLOWED_TOOL_NAMES = new Set([
  'agendar_retorno_ou_followup',
  'consultar_base_conhecimento',
  'consultar_web'
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
  toolConsultarWeb
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
