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
    'preço', 'preco', 'quanto custa', 'orçamento', 'orcamento', 'comprar',
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
  ],
  reclamacao: ['reclamação', 'reclamacao', 'insatisfeito', 'insatisfeita', 'péssimo atendimento', 'pessimo atendimento', 'produto com defeito', 'serviço ruim', 'servico ruim', 'quero reclamar']
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
function buildSectorMap(sectors = [], identity = {}) {
  const ownerNames = [identity.responsible, identity.companyName, ...(Array.isArray(identity.aliases) ? identity.aliases : [])]
    .map(normalizeText)
    .filter(Boolean);
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
    } else if (sNameNorm.includes('reclam') || sDescNorm.includes('reclam') || sNameNorm.includes('ouvidoria')) {
      sectorMap.reclamacao = s;
    } else if (sNameNorm.includes('responsavel') || sNameNorm.includes('diretor') || sDescNorm.includes('diretoria') ||
      ownerNames.some(name => sNameNorm.includes(name))) {
      sectorMap.responsavel = s;
    }
  }
  return { sectorMap, ownerNames };
}

export function resolverSetorPorCategoria(category, sectors = [], identity = {}) {
  if (!category || !Array.isArray(sectors) || !sectors.length) return null;
  const normCat = normalizeText(category);
  const canonical = normCat === 'comercial' ? 'vendas' : normCat;
  const { sectorMap } = buildSectorMap(sectors, identity);
  const matched = sectorMap[canonical] || null;
  return matched ? { sectorId: matched.id || null, sectorName: matched.name || null, category: canonical } : null;
}

export function classificarSetorPorTexto(text, sectors = [], identity = {}) {
  if (!text || typeof text !== 'string') {
    return { sectorId: null, sectorName: null, category: null, confidence: 0 };
  }

  const norm = normalizeText(text);
  const { sectorMap, ownerNames } = buildSectorMap(sectors, identity);

  // Pontuação por palavras-chave customizadas dos setores configurados no painel
  let bestCustomSector = null;
  let bestCustomScore = 0;
  for (const s of sectors) {
    if (!s || s.isActive === false || !Array.isArray(s.keywords) || !s.keywords.length) continue;
    let sScore = 0;
    for (const kw of s.keywords) {
      const kwNorm = normalizeText(kw);
      if (!kwNorm) continue;
      const isPhrase = kwNorm.includes(' ');
      const matched = isPhrase
        ? norm.includes(kwNorm)
        : new RegExp(`(?:^|\\b)${kwNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|$)`, 'i').test(norm);
      if (matched) sScore += isPhrase ? 3 : 1;
    }
    if (sScore > bestCustomScore) {
      bestCustomScore = sScore;
      bestCustomSector = s;
    }
  }

  // Pontuação por categoria
  const scores = { vendas: 0, suporte: 0, financeiro: 0, reclamacao: 0, responsavel: 0 };

  for (const [cat, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    for (const kw of keywords) {
      const kwNorm = normalizeText(kw);
      const isPhrase = kwNorm.includes(' ');
      const matched = isPhrase
        ? norm.includes(kwNorm)
        : new RegExp(`(?:^|\\b)${kwNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|$)`, 'i').test(norm);
      if (matched) {
        // Frases exatas ganham peso maior
        scores[cat] += isPhrase ? 3 : 1;
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

  if (bestCustomSector && bestCustomScore >= maxScore && bestCustomScore >= 1) {
    return {
      sectorId: bestCustomSector.id,
      sectorName: bestCustomSector.name,
      category: bestCustomSector.id,
      confidence: Math.min(1.0, bestCustomScore * 0.3)
    };
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
