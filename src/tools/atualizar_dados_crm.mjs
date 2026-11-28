/**
 * Tool: atualizar_dados_crm
 * Permite à Lia registrar interesse de compra, observações ou tags no perfil do contato
 */
import { applyStageAutomations } from '../crm/stage-automations.mjs';

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
      },
      etiquetas: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: 'Etiquetas (tags) curtas para classificar o lead no CRM (ex: ["orcamento", "site", "urgente"]).'
      }
    },
    required: []
  },
  async execute({ interesse, observacoes, estagio, etiquetas }, context = {}) {
    const session = context.session;
    if (!session) return { success: false, error: 'Não foi possível identificar o contato atual para atualizar o CRM.' };
    if (interesse) session.productInterest = interesse.trim();
    if (observacoes) {
      session.contactNotes = observacoes.trim();
      session.crmNotes = observacoes.trim();
      session.notes = observacoes.trim();
    }
    if (estagio) {
      session.dealStage = estagio;
      applyStageAutomations({
        session,
        newStage: estagio,
        botConfig: context.botConfig,
        notifyAdmin: context.notifyAdmin
      });
    }
    if (Array.isArray(etiquetas) && etiquetas.length > 0) {
      const existing = Array.isArray(session.tags) ? session.tags : [];
      const normalized = etiquetas
        .map((t) => String(t || '').trim().toLowerCase().replace(/\s+/g, '-'))
        .filter(Boolean);
      session.tags = Array.from(new Set([...existing, ...normalized])).slice(0, 20);
    }
    context.store?.markDirty?.();
    return {
      success: true,
      interesse: interesse || null,
      estagio: estagio || null,
      etiquetas: Array.isArray(session.tags) ? session.tags : [],
      message: 'Dados do cliente atualizados com sucesso no CRM.'
    };
  }
};
