/**
 * Ferramenta nativa do Copiloto para gerenciar campanhas seguras (Safe Broadcast),
 * com delays anti-ban, pausa em lotes e controle de execução.
 */
export const toolGerenciarCampanha = {
  name: 'gerenciar_campanha',
  description: 'Cria, lista, pausa, cancela ou executa campanhas de envio seguro (anti-ban com intervalos e lotes) para contatos do CRM.',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: {
        type: 'STRING',
        description: 'Ação desejada: "listar", "criar", "executar", "pausar" ou "cancelar".'
      },
      campaignId: { type: 'STRING', description: 'ID da campanha (para executar, pausar ou cancelar).' },
      title: { type: 'STRING', description: 'Título da campanha (para criar).' },
      message: { type: 'STRING', description: 'Mensagem da campanha (suporta {{nome}}).' },
      recipients: {
        type: 'ARRAY',
        description: 'Lista de destinatários [{ phone, name }].',
        items: {
          type: 'OBJECT',
          properties: {
            phone: { type: 'STRING' },
            name: { type: 'STRING' }
          }
        }
      },
      minDelay: { type: 'NUMBER', description: 'Delay mínimo entre envios em segundos (padrão 10).' },
      maxDelay: { type: 'NUMBER', description: 'Delay máximo entre envios em segundos (padrão 25).' },
      batchSize: { type: 'NUMBER', description: 'Tamanho do lote antes da pausa anti-ban (padrão 10).' },
      batchPauseSeconds: { type: 'NUMBER', description: 'Pausa entre lotes em segundos (padrão 30).' },
      confirmar: { type: 'BOOLEAN', description: 'Confirmação explícita do responsável para criar ou disparar.' }
    },
    required: ['acao']
  },
  async execute(args = {}, context = {}) {
    if (context?.actor === 'client') {
      return { success: false, error: 'owner_only_tool', message: 'Campanhas são exclusivas do responsável.' };
    }
    const store = context?.campaignStore;
    if (!store?.enabled) {
      return { success: false, error: 'campaign_store_unavailable', message: 'O módulo de campanhas requer Supabase ativo.' };
    }
    const acao = String(args.acao || 'listar').trim().toLowerCase();
    if (acao === 'listar') {
      const list = await store.listSummaries();
      return { success: true, campaigns: list.slice(0, 15) };
    }
    if (acao === 'pausar' || acao === 'cancelar') {
      if (!args.campaignId) return { success: false, error: 'missing_campaign_id' };
      const targetStatus = acao === 'pausar' ? 'paused' : 'cancelled';
      const updated = await store.transition(args.campaignId, targetStatus);
      return updated
        ? { success: true, campaign: updated }
        : { success: false, error: 'campaign_not_found' };
    }
    if (acao === 'criar') {
      if (args.confirmar !== true) {
        return {
          success: false,
          requiresConfirmation: true,
          message: `Prévia da campanha "${args.title || 'Sem título'}" para ${Array.isArray(args.recipients) ? args.recipients.length : 0} contato(s). Confirme para criar.`
        };
      }
      const created = await store.create({
        title: args.title,
        message: args.message,
        recipients: args.recipients,
        minDelay: args.minDelay ?? 10,
        maxDelay: args.maxDelay ?? 25,
        batchSize: args.batchSize ?? 10,
        batchPauseSeconds: args.batchPauseSeconds ?? 30,
        actorId: 'copilot'
      });
      return { success: true, campaign: created };
    }
    if (acao === 'executar') {
      if (!args.campaignId) return { success: false, error: 'missing_campaign_id' };
      if (args.confirmar !== true) {
        return {
          success: false,
          requiresConfirmation: true,
          message: `Confirme para iniciar o disparo seguro da campanha ${args.campaignId}.`
        };
      }
      const result = await store.execute(args.campaignId);
      return result
        ? { success: true, campaign: result }
        : { success: false, error: 'campaign_not_found' };
    }
    return { success: false, error: 'invalid_action' };
  }
};
