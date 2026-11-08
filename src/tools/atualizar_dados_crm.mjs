/**
 * Tool: atualizar_dados_crm
 * Permite à Lia registrar interesse de compra, observações ou tags no perfil do contato
 */
export const toolAtualizarDadosCRM = {
  name: 'atualizar_dados_crm',
  description: 'Registra o interesse do cliente, observações relevantes ou estágio de negociação no CRM.',
  parameters: {
    type: 'OBJECT',
    properties: {
      interesse: {
        type: 'STRING',
        description: 'Produto, serviço ou plano em que o cliente demonstrou interesse.'
      },
      observacoes: {
        type: 'STRING',
        description: 'Resumo de informações importantes levantadas durante a conversa.'
      },
      estagio: {
        type: 'STRING',
        enum: ['lead', 'qualificacao', 'proposta', 'negociacao', 'fechado', 'perdido'],
        description: 'Estágio do cliente no funil comercial.'
      }
    },
    required: []
  },
  async execute({ interesse, observacoes, estagio }, context = {}) {
    const session = context.session;
    if (session) {
      if (interesse) session.productInterest = interesse;
      if (observacoes) session.crmNotes = observacoes;
      if (estagio) session.dealStage = estagio;
    }
    return {
      success: true,
      interesse: interesse || null,
      estagio: estagio || null,
      message: 'Dados do cliente atualizados com sucesso no CRM.'
    };
  }
};
