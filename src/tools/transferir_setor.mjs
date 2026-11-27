import { resolverSetorPorCategoria } from '../triage-router.mjs';

/**
 * Tool: transferir_para_setor
 * Permite à Lia acionar o transbordo setorial automático (Vendas, Suporte, Financeiro, Ouvidoria, Diretoria)
 */
export const toolTransferirSetor = {
  name: 'transferir_para_setor',
  description: 'Transfere ativamente o cliente para um setor específico da empresa (Ex: "comercial", "financeiro", "suporte", "ouvidoria", "diretoria").',
  parameters: {
    type: 'OBJECT',
    properties: {
      setor: {
        type: 'STRING',
        description: 'Nome ou ID do setor ativo para onde o cliente deseja ser direcionado.'
      },
      motivo: {
        type: 'STRING',
        description: 'Resumo conciso da solicitação do cliente que motivou a transferência.'
      }
    },
    required: ['setor', 'motivo']
  },
  async execute({ setor, motivo }, context = {}) {
    const cleanSetor = String(setor || '').trim();
    const cleanMotivo = String(motivo || '').trim() || 'Solicitação de atendimento direto';
    const sectors = Array.isArray(context.sectors) ? context.sectors.filter(s => s && s.isActive !== false) : [];

    let resolved = null;
    if (sectors.length > 0) {
      const match = resolverSetorPorCategoria(cleanSetor, sectors, context.identity || {});
      resolved = match?.sectorId ? sectors.find(s => s.id === match.sectorId) : null;
      if (!resolved) {
        const validNames = sectors.map(s => `${s.name} (${s.id})`).join(', ');
        return {
          success: false,
          error: 'invalid_sector',
          message: `Setor "${cleanSetor}" não encontrado ou inativo. Setores disponíveis: ${validNames}.`
        };
      }
    }

    if (typeof context.triggerHandoff === 'function') {
      await context.triggerHandoff({
        reason: cleanMotivo,
        sector: resolved || { id: cleanSetor.toLowerCase(), name: cleanSetor },
        responsiblePhone: resolved?.responsiblePhone || ''
      });
    }

    return {
      success: true,
      handoffExecuted: typeof context.triggerHandoff === 'function',
      handoffRequested: true,
      sectorId: resolved?.id || cleanSetor.toLowerCase(),
      sectorName: resolved?.name || cleanSetor,
      setor: resolved?.id || cleanSetor.toLowerCase(),
      motivo: cleanMotivo,
      message: `Transferência realizada para o setor "${resolved?.name || cleanSetor}".`
    };
  }
};
