import { FAQ, findFaqInItems } from '../knowledge.mjs';
import { findMatchingKnowledgeBaseSync, listKnowledgeBasesSync } from '../knowledge-bases.mjs';

/**
 * Tool: consultar_base_conhecimento
 * Permite à Lia buscar na base de conhecimento FAQ da empresa e nos dossiês Markdown cadastrados
 */
export const toolConsultarBaseConhecimento = {
  name: 'consultar_base_conhecimento',
  description: 'Consulta informações institucionais, políticas, horários, serviços, dossiês de sistemas (ex: Clubinho HomeVet) e regras da empresa na base de conhecimento oficial.',
  parameters: {
    type: 'OBJECT',
    properties: {
      termo: {
        type: 'STRING',
        description: 'Termo de busca, pergunta ou palavra-chave sobre a empresa, sistema ou serviço.'
      }
    },
    required: ['termo']
  },
  async execute({ termo }, context = {}) {
    if (context.actor === 'client') {
      const session = context.session || {};
      const assignedKb = session.supportModeEnabled && session.knowledgeBaseId
        ? listKnowledgeBasesSync().find(kb => kb.id === session.knowledgeBaseId && !kb.copilotOnly)
        : null;
      if (assignedKb?.content) {
        return {
          found: true,
          termo,
          base: assignedKb.title,
          versao: assignedKb.version,
          resposta: assignedKb.content.slice(0, 12000)
        };
      }

      const rawFaq = (context.botConfig?.knowledge?.faq || FAQ || []).filter(item => item?.enabled !== false);
      const answer = findFaqInItems(termo, rawFaq);
      return answer
        ? { found: true, termo, resposta: answer }
        : { found: false, termo, mensagem: 'Nenhum item espec\u00edfico encontrado na base.' };
    }

    const matchedKb = findMatchingKnowledgeBaseSync(termo, undefined, { includeCopilotOnly: true });
    if (matchedKb && matchedKb.content) {
      return {
        found: true,
        termo,
        base: matchedKb.title,
        versao: matchedKb.version,
        resposta: matchedKb.content.slice(0, 12000)
      };
    }

    const sessionKbId = context.session?.knowledgeBaseId;
    if (sessionKbId) {
      const allKbs = listKnowledgeBasesSync();
      const linked = allKbs.find(k => k.id === sessionKbId);
      if (linked && linked.content) {
        return {
          found: true,
          termo,
          base: linked.title,
          versao: linked.version,
          resposta: linked.content.slice(0, 12000)
        };
      }
    }

    const rawFaq = (context.botConfig?.knowledge?.faq || FAQ || []).filter(item => item?.enabled !== false);
    const answer = findFaqInItems(termo, rawFaq);
    if (answer) {
      return {
        found: true,
        termo,
        resposta: answer
      };
    }
    return {
      found: false,
      termo,
      mensagem: 'Nenhum item específico encontrado na base. Siga a postura padrão de recepção.'
    };
  }
};
