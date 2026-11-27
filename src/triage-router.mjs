/**
 * Classificador de Triagem e Roteamento de Setor por Heurística Leve.
 *
 * Executa em microssegundos (< 1ms), com custo ZERO de tokens LLM,
 * classificando a mensagem em um dos setores configurados no painel/Chatwoot.
 */

const SECTOR_KEYWORDS = {
  vendas: [
    { term: 'preço', weight: 3 }, { term: 'preco', weight: 3 }, { term: 'valor', weight: 3 },
    { term: 'mensalidade', weight: 3 }, { term: 'quanto custa', weight: 3 },
    { term: 'orçamento', weight: 3 }, { term: 'orcamento', weight: 3 },
    { term: 'comprar', weight: 2 }, { term: 'adquirir', weight: 2 },
    { term: 'contratar', weight: 3 }, { term: 'plano', weight: 2 }, { term: 'planos', weight: 2 },
    { term: 'proposta', weight: 3 }, { term: 'tabela', weight: 2 }, { term: 'serviços', weight: 2 },
    { term: 'servicos', weight: 2 }, { term: 'quero assinar', weight: 3 },
    { term: 'adesão', weight: 3 }, { term: 'adesao', weight: 3 }, { term: 'quero saber mais', weight: 2 }
  ],
  suporte: [
    { term: 'suporte', weight: 3 }, { term: 'bug', weight: 3 }, { term: 'travou', weight: 3 },
    { term: 'instabilidade', weight: 3 }, { term: 'não funciona', weight: 2 }, { term: 'nao funciona', weight: 2 },
    { term: 'como faz', weight: 2 }, { term: 'onde fica', weight: 2 }, { term: 'não consigo', weight: 2 },
    { term: 'nao consigo', weight: 2 }, { term: 'login', weight: 2 }, { term: 'senha', weight: 2 },
    { term: 'acesso', weight: 1 }, { term: 'como uso', weight: 2 }, { term: 'manual', weight: 2 },
    { term: 'tutorial', weight: 2 }, { term: 'erro', weight: 1 }, { term: 'problema', weight: 1 },
    { term: 'ajuda', weight: 1 }, { term: 'duvida', weight: 1 }, { term: 'dúvida', weight: 1 }
  ],
  financeiro: [
    { term: 'boleto', weight: 4 }, { term: 'fatura', weight: 4 }, { term: 'pix', weight: 4 },
    { term: 'nota fiscal', weight: 4 }, { term: 'nf', weight: 3 }, { term: 'pagamento', weight: 4 },
    { term: 'pagar', weight: 2 }, { term: 'comprovante', weight: 4 }, { term: 'segunda via', weight: 4 },
    { term: '2a via', weight: 4 }, { term: 'estorno', weight: 4 }, { term: 'reembolso', weight: 4 },
    { term: 'cobrança', weight: 4 }, { term: 'cobranca', weight: 4 }, { term: 'vencimento', weight: 4 }
  ],
  agendamento: [
    { term: 'agendar', weight: 3 }, { term: 'reagendar', weight: 3 }, { term: 'remarcar', weight: 3 },
    { term: 'marcar', weight: 2 }, { term: 'consulta', weight: 3 }, { term: 'reunião', weight: 3 },
    { term: 'reuniao', weight: 3 }, { term: 'horário', weight: 2 }, { term: 'horario', weight: 2 },
    { term: 'agenda', weight: 2 }
  ],
  responsavel: [
    { term: 'falar com o responsavel', weight: 3 }, { term: 'falar com a responsavel', weight: 3 },
    { term: 'responsavel', weight: 2 }, { term: 'responsável', weight: 2 }, { term: 'dono', weight: 3 },
    { term: 'diretor', weight: 3 }, { term: 'diretoria', weight: 3 },
    { term: 'urgente', weight: 2 }, { term: 'urgência', weight: 2 }, { term: 'emergencia', weight: 3 }, { term: 'emergência', weight: 3 }
  ],
  reclamacao: [
    { term: 'reclamação', weight: 3 }, { term: 'reclamacao', weight: 3 },
    { term: 'insatisfeito', weight: 3 }, { term: 'insatisfeita', weight: 3 },
    { term: 'péssimo atendimento', weight: 3 }, { term: 'pessimo atendimento', weight: 3 },
    { term: 'produto com defeito', weight: 3 }, { term: 'serviço ruim', weight: 3 },
    { term: 'servico ruim', weight: 3 }, { term: 'quero reclamar', weight: 3 },
    { term: 'cancelar', weight: 3 }, { term: 'cancelamento', weight: 3 }
  ]
};

const CATEGORY_PRIORITY = ['reclamacao', 'responsavel', 'financeiro', 'agendamento', 'suporte', 'vendas'];

function normalizeText(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function buildSectorMap(sectors = [], identity = {}) {
  const ownerNames = [identity.responsible, identity.companyName, ...(Array.isArray(identity.aliases) ? identity.aliases : [])]
    .map(normalizeText)
    .filter(n => n.length >= 3);
  const sectorMap = {};
  for (const s of sectors) {
    if (!s || s.isActive === false) continue;
    const sIdNorm = normalizeText(s.id || '');
    const sNameNorm = normalizeText(s.name || '');

    if (!sectorMap.vendas && (sIdNorm === 'vendas' || sNameNorm.includes('venda') || sNameNorm.includes('comercial'))) {
      sectorMap.vendas = s;
    } else if (!sectorMap.suporte && (sIdNorm === 'suporte' || sNameNorm.includes('suporte') || sNameNorm.includes('tecnico'))) {
      sectorMap.suporte = s;
    } else if (!sectorMap.financeiro && (sIdNorm === 'financeiro' || sNameNorm.includes('financ') || sNameNorm.includes('cobranc'))) {
      sectorMap.financeiro = s;
    } else if (!sectorMap.agendamento && (sIdNorm === 'agendamento' || sNameNorm.includes('agend'))) {
      sectorMap.agendamento = s;
    } else if (!sectorMap.reclamacao && (sIdNorm === 'ouvidoria' || sNameNorm.includes('reclam') || sNameNorm.includes('ouvidoria') || sNameNorm.includes('retenc'))) {
      sectorMap.reclamacao = s;
    } else if (!sectorMap.responsavel && (sIdNorm === 'diretoria' || sNameNorm.includes('responsavel') || sNameNorm.includes('diretor') ||
      ownerNames.some(name => sNameNorm.includes(name)))) {
      sectorMap.responsavel = s;
    }
  }
  return { sectorMap, ownerNames };
}

export function resolverSetorPorCategoria(category, sectors = [], identity = {}) {
  if (!category || !Array.isArray(sectors) || !sectors.length) return null;
  const normCat = normalizeText(category);
  const canonical = normCat === 'comercial' ? 'vendas' : (normCat === 'ouvidoria' ? 'reclamacao' : normCat);
  const direct = sectors.find(s =>
    s && s.isActive !== false && (normalizeText(s.id || '') === normCat || normalizeText(s.name || '') === normCat)
  );
  if (direct) {
    return { sectorId: direct.id || null, sectorName: direct.name || null, category: canonical };
  }
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

  const scores = { vendas: 0, suporte: 0, financeiro: 0, agendamento: 0, reclamacao: 0, responsavel: 0 };

  for (const [cat, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    for (const entry of keywords) {
      const kwNorm = normalizeText(entry.term);
      const isPhrase = kwNorm.includes(' ');
      const matched = isPhrase
        ? norm.includes(kwNorm)
        : new RegExp(`(?:^|\\b)${kwNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|$)`, 'i').test(norm);
      if (matched) {
        scores[cat] += entry.weight || 1;
      }
    }
  }

  if (ownerNames.some(name => norm.includes(name))) {
    scores.responsavel += 2;
  }

  let bestCategory = null;
  let maxScore = 0;
  for (const cat of CATEGORY_PRIORITY) {
    const score = scores[cat] || 0;
    if (score > maxScore) {
      maxScore = score;
      bestCategory = cat;
    }
  }

  if (bestCustomSector && bestCustomScore > maxScore && bestCustomScore >= 1) {
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
