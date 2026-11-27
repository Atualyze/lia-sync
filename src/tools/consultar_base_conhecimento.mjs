import { FAQ, findFaqInItems } from '../knowledge.mjs';
import { findMatchingKnowledgeBaseSync, findGuidanceKnowledgeSync, getRelevantKnowledgeBaseContentSync, listKnowledgeBasesSync } from '../knowledge-bases.mjs';

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
      const kbIds = [...new Set([
        ...(Array.isArray(session.knowledgeBaseIds) ? session.knowledgeBaseIds : []),
        ...(session.knowledgeBaseId ? [session.knowledgeBaseId] : [])
      ].map(x => String(x || '').trim()).filter(Boolean))];
      const allKbs = listKnowledgeBasesSync();
      const assignedKbs = (session.supportModeEnabled || kbIds.length)
        ? kbIds.map(id => allKbs.find(kb => kb.id === id && !kb.copilotOnly)).filter(kb => kb?.content)
        : [];
      if (assignedKbs.length) {
        const perMax = assignedKbs.length > 1 ? Math.max(2000, Math.floor(7500 / assignedKbs.length)) : 6500;
        const excerpts = assignedKbs.map(kb => {
          const relevant = getRelevantKnowledgeBaseContentSync(kb.id, termo, undefined, { maxChars: perMax });
          return `[${kb.title} v${kb.version}]\n${relevant?.content || kb.content.slice(0, 1800)}`;
        });
        return {
          found: true,
          termo,
          base: assignedKbs.map(k => k.title).join(', '),
          versao: assignedKbs[0].version,
          resposta: excerpts.join('\n\n---\n\n')
        };
      }

      const rawFaq = (context.botConfig?.knowledge?.faq || FAQ || []).filter(item => item?.enabled !== false);
      const answer = findFaqInItems(termo, rawFaq);
      if (answer) {
        return { found: true, termo, resposta: answer };
      }
      if (!session.knowledgeBaseId) {
        const guidance = findGuidanceKnowledgeSync(termo, undefined, { maxChars: 3000 });
        if (guidance?.content) {
          return {
            found: true,
            termo,
            base: guidance.title,
            versao: guidance.version,
            resposta: guidance.content
          };
        }
      }
      return { found: false, termo, mensagem: 'Nenhum item espec\u00edfico encontrado na base.' };
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
