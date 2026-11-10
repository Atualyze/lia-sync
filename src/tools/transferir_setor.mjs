/**
 * Tool: transferir_para_setor
 * Permite à Lia acionar o transbordo setorial automático (Vendas, Suporte, Financeiro, Jurídico)
 */
export const toolTransferirSetor = {
  name: 'transferir_para_setor',
  description: 'Transfere ativamente o cliente para um setor específico da empresa (Ex: "comercial", "financeiro", "suporte", "diretoria").',
  parameters: {
    type: 'OBJECT',
    properties: {
      setor: {
        type: 'STRING',
        description: 'Nome do setor para onde o cliente deseja ser direcionado. Ex: "comercial", "financeiro", "suporte", "responsavel".'
      },
      motivo: {
        type: 'STRING',
        description: 'Resumo conciso da solicitação do cliente que motivou a transferência.'
      }
    },
    required: ['setor', 'motivo']
  },
  async execute({ setor, motivo }, context = {}) {
    const cleanSetor = String(setor || '').toLowerCase().trim();
    return {
      success: true,
      setor: cleanSetor,
      motivo: motivo || 'Solicitação de atendimento direto',
      handoffRequested: true,
      message: `Transferência solicitada com sucesso para o setor "${cleanSetor}".`
    };
  }
};
