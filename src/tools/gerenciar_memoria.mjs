import { memoryStore, buildMemoryScopeKey } from '../core/memory.mjs';

export const toolGerenciarMemoria = {
  name: 'gerenciar_memoria',
  description: 'Consulta, salva, corrige ou esquece memórias persistentes de longo prazo do contato atual (preferências, projetos e decisões).',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: {
        type: 'STRING',
        enum: ['consultar', 'salvar', 'corrigir', 'esquecer'],
        description: 'Operação desejada na memória persistente.'
      },
      tipo: {
        type: 'STRING',
        enum: ['preference', 'project', 'decision', 'fact'],
        description: 'Categoria da memória ao salvar ou corrigir.'
      },
      conteudo: {
        type: 'STRING',
        description: 'Texto da memória a salvar, ou novo conteúdo ao corrigir.'
      },
      referencia: {
        type: 'STRING',
        description: 'ID ou trecho da memória existente ao corrigir ou esquecer.'
      }
    },
    required: ['acao']
  },
  async execute(args = {}, context = {}) {
    const store = context.memoryStore || memoryStore;
    const scopeKey = buildMemoryScopeKey({
      tenantId: context.tenantId || 'default',
      phone: context.phone || context.targetPhone || context.session?.phone || '',
      isOwner: Boolean(context.isOwner || context.actor === 'owner')
    });

    const acao = String(args.acao || 'consultar').toLowerCase();

    if (acao === 'consultar') {
      const list = store.list(scopeKey);
      return {
        success: true,
        acao,
        total: list.length,
        memorias: list.slice(0, 12).map((m) => ({
          id: m.id,
          tipo: m.type,
          conteudo: m.content,
          atualizadoEm: m.updatedAt
        }))
      };
    }

    if (acao === 'salvar') {
      const res = store.remember({
        scopeKey,
        type: args.tipo || 'fact',
        content: args.conteudo || '',
        importance: 0.85,
        confidence: 0.95,
        source: 'explicit'
      });
      return {
        success: Boolean(res.saved),
        acao,
        ...res
      };
    }

    if (acao === 'corrigir') {
      const res = store.correct({
        scopeKey,
        idOrQuery: args.referencia || '',
        newContent: args.conteudo || '',
        type: args.tipo
      });
      return {
        success: Boolean(res.updated),
        acao,
        ...res
      };
    }

    if (acao === 'esquecer') {
      const res = store.forget({
        scopeKey,
        idOrQuery: args.referencia || args.conteudo || ''
      });
      return {
        success: Boolean(res.forgotten),
        acao,
        ...res
      };
    }

    return { success: false, error: 'Ação de memória não reconhecida.' };
  }
};
