import { toolConsultarContato } from './consultar_contato.mjs';
import { toolAgendarRetorno } from './agendar_retorno.mjs';
import { toolTransferirSetor } from './transferir_setor.mjs';
import { toolConsultarBaseConhecimento } from './consultar_base_conhecimento.mjs';
import { toolAtualizarDadosCRM } from './atualizar_dados_crm.mjs';
import { toolEnviarMensagemContato } from './enviar_mensagem_contato.mjs';
import { toolConsultarSaudeInfra } from './consultar_saude_infra.mjs';
import { toolGerenciarAgendaGoogle } from './gerenciar_agenda_google.mjs';
import { toolGerarDocumentoPdf } from './gerar_documento_pdf.mjs';

export const ALL_TOOLS = [
  toolTransferirSetor,
  toolAgendarRetorno,
  toolConsultarContato,
  toolConsultarBaseConhecimento,
  toolAtualizarDadosCRM,
  toolEnviarMensagemContato,
  toolConsultarSaudeInfra,
  toolGerenciarAgendaGoogle,
  toolGerarDocumentoPdf
];

const CLIENT_ALLOWED_TOOL_NAMES = new Set([
  'agendar_retorno_ou_followup',
  'consultar_base_conhecimento'
]);
export const isClientToolAllowed = (toolName) => CLIENT_ALLOWED_TOOL_NAMES.has(toolName);

export {
  toolConsultarContato,
  toolAgendarRetorno,
  toolTransferirSetor,
  toolConsultarBaseConhecimento,
  toolAtualizarDadosCRM,
  toolEnviarMensagemContato,
  toolConsultarSaudeInfra,
  toolGerenciarAgendaGoogle,
  toolGerarDocumentoPdf
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

/**
 * Executa uma ferramenta pelo nome com os argumentos passados
 */
export async function executeToolCall(toolName, args = {}, context = {}) {
  if (context.actor === 'client' && !CLIENT_ALLOWED_TOOL_NAMES.has(toolName)) {
    return { error: 'Ferramenta indisponível neste fluxo.' };
  }
  const tool = ALL_TOOLS.find(t => t.name === toolName);
  if (!tool) {
    return { error: 'Ferramenta "' + toolName + '" não encontrada.' };
  }
  try {
    return await tool.execute(args, context);
  } catch (err) {
    return { error: 'Falha ao executar ' + toolName + ': ' + err.message };
  }
}
