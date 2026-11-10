/**
 * Classificador de Triagem e Roteamento de Setor por Heurística Leve.
 *
 * Executa em microssegundos (< 1ms), com custo ZERO de tokens LLM,
 * classificando a mensagem em um dos setores configurados no Chatwoot/Lia:
 * - Comercial / Vendas
 * - Suporte / Técnico
 * - Financeiro / Cobrança
 * - Responsável / Diretoria
 */

const SECTOR_KEYWORDS = {
  vendas: [
    'preço', 'preco', 'valor', 'quanto custa', 'orçamento', 'orcamento', 'comprar',
    'adquirir', 'contratar', 'plano', 'planos', 'proposta', 'tabela', 'serviços', 'servicos',
    'quero assinar', 'adesão', 'adesao', 'quero saber mais'
  ],
  suporte: [
    'ajuda', 'suporte', 'duvida', 'dúvida', 'não funciona', 'nao funciona', 'erro', 'bug',
    'travou', 'instabilidade', 'problema', 'como faz', 'onde fica', 'não consigo', 'nao consigo',
    'login', 'senha', 'acesso', 'como uso', 'manual', 'tutorial'
  ],
  financeiro: [
    'boleto', 'fatura', 'pix', 'nota fiscal', 'nf', 'pagamento', 'pagar', 'comprovante',
    'segunda via', '2a via', 'estorno', 'reembolso', 'cobrança', 'cobranca', 'vencimento'
  ],
  responsavel: [
    'falar com o responsavel', 'falar com a responsavel', 'responsavel', 'responsável', 'dono',
    'diretor', 'diretoria', 'urgente', 'urgência', 'emergencia', 'emergência'
  ]
};

/**
 * Normaliza texto para correspondência sem acentos e em minúsculas.
 */
function normalizeText(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Classifica o setor mais provável com base no texto da mensagem e setores cadastrados.
 * @param {string} text - Texto recebido do contato.
 * @param {Array} sectors - Lista de setores do sistema ({ id, name, description }).
 * @param {{ responsible?: string, companyName?: string, aliases?: string[] }} identity - Identidade configurada.
 * @returns {{ sectorId: string|null, sectorName: string|null, category: string|null, confidence: number }}
 */
export function classificarSetorPorTexto(text, sectors = [], identity = {}) {
  if (!text || typeof text !== 'string') {
    return { sectorId: null, sectorName: null, category: null, confidence: 0 };
  }

  const norm = normalizeText(text);
  const ownerNames = [identity.responsible, identity.companyName, ...(Array.isArray(identity.aliases) ? identity.aliases : [])]
    .map(normalizeText)
    .filter(Boolean);

  // Mapeia setores cadastrados para categorias padrão
  const sectorMap = {};
  for (const s of sectors) {
    if (!s || s.isActive === false) continue;
    const sNameNorm = normalizeText(s.name);
    const sDescNorm = normalizeText(s.description || '');

    if (sNameNorm.includes('venda') || sNameNorm.includes('comercial') || sDescNorm.includes('proposta')) {
      sectorMap.vendas = s;
    } else if (sNameNorm.includes('suporte') || sNameNorm.includes('tecnico') || sDescNorm.includes('ajuda')) {
      sectorMap.suporte = s;
    } else if (sNameNorm.includes('financ') || sNameNorm.includes('cobranc') || sDescNorm.includes('boleto')) {
      sectorMap.financeiro = s;
    } else if (sNameNorm.includes('responsavel') || sNameNorm.includes('diretor') || sDescNorm.includes('diretoria') ||
      ownerNames.some(name => sNameNorm.includes(name))) {
      sectorMap.responsavel = s;
    }
  }

  // Pontuação por categoria
  const scores = { vendas: 0, suporte: 0, financeiro: 0, responsavel: 0 };

  for (const [cat, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    for (const kw of keywords) {
      const kwNorm = normalizeText(kw);
      if (norm.includes(kwNorm)) {
        // Frases exatas ganham peso maior
        scores[cat] += kwNorm.includes(' ') ? 3 : 1;
      }
    }
  }

  // Nomes configurados (responsável, empresa, apelidos) contam como pedido ao responsável
  if (ownerNames.some(name => name.length >= 3 && norm.includes(name))) {
    scores.responsavel += 2;
  }

  // Encontra a categoria com maior pontuação
  let bestCategory = null;
  let maxScore = 0;
  for (const [cat, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      bestCategory = cat;
    }
  }

  if (bestCategory && maxScore >= 1) {
    const matchedSector = sectorMap[bestCategory];
    return {
      sectorId: matchedSector?.id || null,
      sectorName: matchedSector?.name || null,
      category: bestCategory,
      confidence: Math.min(1.0, maxScore * 0.3)
    };
  }

  return { sectorId: null, sectorName: null, category: null, confidence: 0 };
}
