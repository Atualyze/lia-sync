const tokens = (text = '') => normalize(text).split(/\s+/).filter(Boolean);

const ADMIN_AUTHORITY_CLAIM_RE = /\b(?:sou|aqui e|estou falando como|falo em nome de|represento|tenho autorizacao de)\s+(?:(?:o|a)\s+)?(?:admin(?:istrador)?|dono|proprietario|responsavel|gestor|diretor|administracao)\b/;
const SECRET_TERMS_RE = /\b(?:senha|password|api key|chave de api|token|credenciais?|segredo|secret|webhook secret|service role|chave privada|supabase secret key|github token)\b/;
const SECRET_REQUEST_RE = /\b(?:me passe|me manda|me envie|envie|mande|mostre|revele|informe|diga|forneca|compartilhe|extraia|qual e|onde esta|me de|me da|quero|preciso|acesse|copie)\b/;
const INSTRUCTION_OVERRIDE_RE = /\b(?:ignore|desconsidere|esqueca|apague|anule|substitua|sobrescreva|contorne)\b.{0,90}\b(?:instrucoes|regras|prompt|sistema|restricoes|politica|seguranca)\b/;
const INTERNAL_DATA_RE = [
  /\b(?:dados|informacoes|historico|conversas|contatos|telefones|cadastros|fichas)\b.{0,70}\b(?:de todos os clientes|dos clientes|de outros clientes|de clientes|de leads|do crm|de funcionarios)\b/,
  /\b(?:lista|base|cadastro)\b.{0,55}\b(?:completa\s+)?(?:de\s+)?(?:clientes|leads|contatos)\b/,
  /\b(?:drive|planilhas?|crm|banco de dados|agenda|logs?|configuracoes|arquivos|documentos)\b.{0,65}\b(?:intern[oa]s?|privad[oa]s?|administrativ[oa]s?|do admin|do responsavel|da equipe|do sistema|do servidor)\b/,
  /\b(?:revele|mostre|envie|compartilhe|liste|extraia|acesse|leia)\b.{0,65}\b(?:drive|planilhas?|crm|banco de dados|agenda|arquivos|documentos|dados de clientes)\b/
];

/**
 * Detecta tentativa de assumir privilégios ou extrair dados internos em uma
 * conversa autenticada como cliente. A classificação é determinística e não
 * concede poderes com base em alegações feitas no texto.
 */
export function classifyClientSecurityRisk(text = '', { ownerName = '' } = {}) {
  const value = normalize(text);
  if (!value) return null;

  const normalizedOwner = normalize(ownerName);
  const namedOwnerClaim = normalizedOwner && [
    'sou ' + normalizedOwner,
    'sou o ' + normalizedOwner,
    'aqui e ' + normalizedOwner,
    'aqui e o ' + normalizedOwner,
    'estou falando como ' + normalizedOwner,
    'falo em nome de ' + normalizedOwner
  ].some(claim => value.includes(claim));
  const claimsAuthority = ADMIN_AUTHORITY_CLAIM_RE.test(value) || Boolean(namedOwnerClaim);
  const asksForSecrets = SECRET_TERMS_RE.test(value) && SECRET_REQUEST_RE.test(value);
  const asksForSensitiveCredential = /\b(?:senha\s+(?:do|da)\s+(?:admin|administrador|painel|servidor|banco|sistema)|api key|chave de api|token\s+(?:de acesso|admin|administrativo|secreto)|credenciais?\s+(?:internas?|do admin|da empresa|do servidor)|chave privada|webhook secret|service role|supabase secret key|github token)\b/.test(value);
  const overridesInstructions = INSTRUCTION_OVERRIDE_RE.test(value)
    || /\b(?:revele|mostre|imprima|repita|copie|exponha)\b.{0,70}\b(?:prompt do sistema|instrucoes internas|regras internas|mensagem de sistema)\b/.test(value);
  const extractsInternalData = INTERNAL_DATA_RE.some(pattern => pattern.test(value));

  if (claimsAuthority) return 'privilege_escalation';
  if (asksForSensitiveCredential || asksForSecrets) return 'credential_extraction';
  if (overridesInstructions) return 'instruction_override';
  if (extractsInternalData) return 'internal_data_extraction';
  return null;
}

export function normalize(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const has = (text, pattern) => pattern.test(normalize(text));

/**
 * Filtro de urgência/emergência geral ou pedido crítico de atendimento.
 *
 * Regra de produto: a Lia Sync não faz triagem técnica de nenhum setor.
 * Ela apenas identifica pedidos de urgência, fraude, invasão, ameaça ou
 * processo judicial e aciona o handoff humano. O conteúdo do atendimento
 * vem da base de conhecimento do cliente.
 */
const EMERGENCY_PATTERNS = [
  /\burgente\b/,
  /\burgencia\b/,
  /\bsocorro\b/,
  /\bgolpe\b/,
  /\bfraude\b/,
  /\binvasao\b/,
  /\bprocesso judicial\b/,
  /\bameaca\b/
];

const EMERGENCY_NEGATION = /\b(?:nao|sem|nunca)\b[\s\S]{0,24}\b(?:urgente|urgencia|socorro|fraude|invasao|ameaca|processo judicial)\b/;

export function isEmergency(text = '') {
  const n = normalize(text);
  if (EMERGENCY_NEGATION.test(n)) return false;
  return EMERGENCY_PATTERNS.some(p => p.test(n));
}

export function sanitizeInput(text, max = 2000) {
  return String(text || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\[\[[\s\S]*?\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function parsePriceToCents(str = '') {
  const clean = String(str).replace(/[^\d,.]/g, '').trim();
  if (!clean) return null;
  if (clean.includes(',')) {
    const [intPart, decPart] = clean.split(',');
    const intNum = parseInt(intPart.replace(/\./g, ''), 10) || 0;
    const decNum = parseInt((decPart + '00').slice(0, 2), 10) || 0;
    return intNum * 100 + decNum;
  }
  const intNum = parseInt(clean.replace(/\./g, ''), 10);
  return Number.isNaN(intNum) ? null : intNum * 100;
}

/** Unidades que descartam um número solto como valor monetário ("fica 3 dias"). */
const UNIT_AFTER = /^\s*(?:dias?|horas?|h|min(?:utos?)?|segundos?|meses|m[eê]s|anos?|semanas?|vezes|unidades?|un|kg|g|mg|ml|l|km|metros?|%|por\s*cento)\b/i;

const NUM_WORDS = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14,
  catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19,
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70,
  oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200, trezentos: 300,
  quatrocentos: 400, quinhentos: 500, seiscentos: 600, setecentos: 700,
  oitocentos: 800, novecentos: 900
};

/** Converte um valor escrito por extenso ("cento e cinquenta") em número. */
function numberFromWords(words = '') {
  const parts = normalize(words).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  let total = 0;
  let current = 0;
  let matched = false;
  for (const part of parts) {
    if (part === 'e') continue;
    if (part === 'mil') {
      total += (current || 1) * 1000;
      current = 0;
      matched = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(NUM_WORDS, part)) {
      current += NUM_WORDS[part];
      matched = true;
      continue;
    }
    return null;
  }
  return matched ? total + current : null;
}

/**
 * Detecta menções monetárias em texto livre.
 * Cobre "R$ 1.500", "R$ 1.500,00", "150,00", "15,50", "cento e cinquenta reais",
 * "150 mil reais" e valores precedidos de valor/custa/custam/sai/fica/por.
 * Inteiros soltos ("3 unidades", "2024", "12h") não são preço sem contexto.
 */
export function detectPriceMentions(text = '') {
  const source = String(text || '');
  const found = [];
  const seen = new Set();
  const push = (raw, cents) => {
    if (!Number.isFinite(cents) || cents <= 0) return;
    const key = `${String(raw).trim()}|${cents}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ raw: String(raw).trim(), cents });
  };

  // 1) Valores com moeda explícita: R$ 1.500, R$ 1.500,00, R$150
  for (const m of source.matchAll(/\bR\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/gi)) {
    push(m[0], parsePriceToCents(`${m[1]}${m[2] !== undefined ? `,${m[2]}` : ''}`));
  }

  // 2) Números seguidos de "reais", inclusive "mil reais"
  for (const m of source.matchAll(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*(mil\s+)?reais?\b/gi)) {
    const base = parsePriceToCents(`${m[1]}${m[2] !== undefined ? `,${m[2]}` : ''}`);
    if (base !== null) push(m[0], m[3] ? base * 1000 : base);
  }

  // 3) Valores por extenso: "cento e cinquenta reais"
  for (const m of source.matchAll(/([A-Za-zÀ-ú]+(?:\s+[A-Za-zÀ-ú]+){0,5})\s*reais?\b/gi)) {
    const cents = numberFromWords(m[1]);
    if (cents !== null) push(m[0], cents * 100);
  }

  // 4) Centavos explícitos sem símbolo de moeda: 150,00 / 15,50
  for (const m of source.matchAll(/\b(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\b/g)) {
    push(m[0], parsePriceToCents(`${m[1]},${m[2]}`));
  }

  // 5) Número com contexto de valor/custo
  const contextRe = /\b(?:valor|precos?|custa|custam|sai|fica|por)\s+(?:de\s+|e\s+|eh\s+)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\b/gi;
  for (const m of source.matchAll(contextRe)) {
    const after = source.slice((m.index || 0) + m[0].length);
    const hasCents = m[2] !== undefined;
    const hasThousands = /\./.test(m[1]);
    if (!hasCents && !hasThousands && UNIT_AFTER.test(after)) continue;
    push(m[0], parsePriceToCents(`${m[1]}${hasCents ? `,${m[2]}` : ''}`));
  }

  return found;
}

/** Extrai os valores monetários de um texto já normalizados para comparação. */
export function extractAllowedPrices(text = '') {
  return detectPriceMentions(text).map(item => item.raw.replace(/\s/g, ''));
}

export function stripRedundantSelfIntroduction(reply = '', { alreadyIntroduced = false, botName = 'Lia' } = {}) {
  const raw = String(reply || '').trim();
  if (!alreadyIntroduced || !raw) return raw;
  const escapedBot = String(botName || 'Lia').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Remove prefixos típicos de primeiro contato quando um modelo de fallback assume conversa já em andamento
  const introPattern = new RegExp(
    `^(?:(?:ol[aá]|oi|bom\\s+dia|boa\\s+tarde|boa\\s+noite|opa|e\\s+a[ií])[,!\\s.]+)?` +
    `(?:tudo\\s+(?:bem|bom|certo)(?:\\s+com\\s+voc[eê]|\\s+por\\s+a[ií])?[?!.\\s]+)?` +
    `(?:eu\\s+sou|sou|aqui\\s+[eé]|me\\s+chamo)\\s+(?:a\\s+|o\\s+)?\\*?${escapedBot}\\*?` +
    `(?:[,\\s]+(?:(?:a|o|sua|seu)\\s+)?(?:assistente|copiloto|atendente)[^.!?\n]*[.!?]+|[.!?\n]+)\\s*` +
    `(?:(?:como|em\\s+que)\\s+posso\\s+(?:te\\s+)?ajudar(?:\\s+hoje|\\s+agora)?[?!.\\s]*)?`,
    'i'
  );
  const stripped = raw.replace(introPattern, '').trim();
  if (stripped.length >= 12) {
    return stripped[0].toUpperCase() + stripped.slice(1);
  }
  return raw;
}

const INVENTED_URL_RE = /https?:\/\/(?:\[[0-9A-Fa-f:.]+\](?::\d+)?|[^\s/?#()<>[\]"'`]+)[^\s()<>[\]"'`]*/gi;
const RESERVED_INVENTED_TLDS = new Set(['local', 'localhost', 'internal', 'test', 'example', 'invalid', 'lan']);
const PLACEHOLDER_HOSTS = new Set([
  'example.com', 'www.example.com', 'exemplo.com', 'exemplo.com.br',
  'seu-dominio.com', 'seu-dominio.com.br', 'seudominio.com', 'seudominio.com.br',
  'seusite.com', 'seusite.com.br', 'meusite.com', 'meusite.com.br',
  'empresa.com.br', 'pix.empresa.com.br',
  'lia', 'lia-bot', 'paperclip'
]);
const KNOWN_LIA_ROUTES = /^\/(?:pix|pay|painel|api\/public)(?:\/|$)/i;

function isLoopbackOrInventedHost(hostname = '') {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (PLACEHOLDER_HOSTS.has(host)) return true;
  const labels = host.split('.');
  const tld = labels.at(-1) || '';
  if (labels.length >= 2 && RESERVED_INVENTED_TLDS.has(tld)) return true;
  return false;
}

/**
 * Remove ou corrige links inventados/locais (localhost, 127.0.0.1, *.local, seu-dominio.com)
 * que jamais abririam no WhatsApp do cliente ou do responsável.
 */
export function sanitizeInventedLinks(text = '', { ownOrigin = '' } = {}) {
  const raw = String(text || '');
  if (!raw.includes('://')) return { text: raw, removedCount: 0, rewrittenCount: 0 };
  let safeOrigin = '';
  if (ownOrigin) {
    try {
      const parsed = new URL(ownOrigin);
      if (['http:', 'https:'].includes(parsed.protocol) && !isLoopbackOrInventedHost(parsed.hostname)) {
        safeOrigin = parsed.origin;
      }
    } catch {}
  }

  let removedCount = 0;
  let rewrittenCount = 0;
  const cleaned = raw.replace(INVENTED_URL_RE, (match) => {
    const trailingMatch = match.match(/[.,;:!?]+$/);
    const trailing = trailingMatch ? trailingMatch[0] : '';
    const candidate = trailing ? match.slice(0, -trailing.length) : match;
    let url;
    try {
      url = new URL(candidate);
    } catch {
      return match;
    }
    if (safeOrigin && url.origin === safeOrigin) return match;
    if (!isLoopbackOrInventedHost(url.hostname)) return match;
    if (safeOrigin && KNOWN_LIA_ROUTES.test(url.pathname)) {
      rewrittenCount += 1;
      return `${safeOrigin}${url.pathname}${url.search}${url.hash}${trailing}`;
    }
    removedCount += 1;
    return trailing;
  });

  const normalized = cleaned
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim();

  return { text: normalized, removedCount, rewrittenCount };
}

export function convertMarkdownTablesToBullets(text = '') {
  const lines = String(text || '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const sep = lines[i + 1];
    if (
      /^\s*\|.+\|\s*$/.test(header)
      && typeof sep === 'string'
      && /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(sep)
    ) {
      const headers = header.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
      i += 2;
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
        const first = cells[0] || '';
        const rest = cells.slice(1).filter(Boolean).join(' — ');
        if (first || rest) {
          const prefix = first ? `*${first}:*` : (headers[0] ? `*${headers[0]}:*` : '');
          out.push(`• ${prefix}${rest ? ` ${rest}` : ''}`.trim());
        }
        i += 1;
      }
      continue;
    }
    out.push(header);
    i += 1;
  }
  return out.join('\n');
}

export function formatIsoTimestampsForHumans(text = '', timeZone = 'America/Sao_Paulo') {
  return String(text || '').replace(
    /\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/g,
    (match) => {
      const d = new Date(match);
      if (Number.isNaN(d.getTime())) return match;
      const dateStr = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
      const timeStr = new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
      return `${dateStr} às ${timeStr}`;
    }
  );
}

export function filterReply(reply = '', { allowedPrices = new Set(), isCopilot = false, maxLength, strictPrices = false, alreadyIntroduced = false, botName = 'Lia', ownOrigin = '' } = {}) {
  let text = formatIsoTimestampsForHumans(convertMarkdownTablesToBullets(String(reply || '')))
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .replace(/\s*—\s*/g, ' - ')
    .replace(/(?<!:)\/\/[^\n]*/g, '')
    .replace(/\*\*(.*?)\*\*/gs, '*$1*')
    .replace(/__(.*?)__/gs, '*$1*')
    .replace(/^\s*#{1,6}\s?/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/([^\n])\s*•\s*/g, '$1\n• ')
    .replace(/\[\[[\s\S]*?\]\]/g, '')
    .replace(/como uma IA|como modelo de linguagem/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const linkCheck = sanitizeInventedLinks(text, { ownOrigin });
  text = linkCheck.text;

  if (alreadyIntroduced) {
    text = stripRedundantSelfIntroduction(text, { alreadyIntroduced: true, botName });
  }

  const violations = [];

  const allowedCents = new Set();
  const allowedRaw = new Set();
  for (const p of allowedPrices || []) {
    const c = parsePriceToCents(p);
    if (c !== null) allowedCents.add(c);
    const normalizedPrice = String(p).replace(/\s/g, '').toLowerCase();
    if (normalizedPrice) allowedRaw.add(normalizedPrice);
  }

  // Em modo estrito (caminho de cliente) a checagem roda mesmo sem preço cadastrado:
  // sem fonte de preços, nenhum valor específico pode ser confirmado (fail-closed).
  // Sem modo estrito, só bloqueia quando existem preços permitidos conhecidos
  // (compatível com chamadas anteriores). Copiloto nunca é bloqueado por preço.
  const enforcePrices = !isCopilot && (strictPrices === true || allowedCents.size > 0 || allowedRaw.size > 0);
  if (enforcePrices) {
    for (const mention of detectPriceMentions(text)) {
      const normalizedValue = mention.raw.replace(/\s/g, '').toLowerCase();
      const isAllowed = allowedRaw.has(normalizedValue) || allowedCents.has(mention.cents);
      if (!isAllowed) violations.push('preco');
    }
  }

  if (/100% garantid[oa]|cura milagrosa|fique rico/i.test(text)) violations.push('absoluto');
  if (/(?:d[eê]\s+\d+\s*(?:mg|ml|gotas)|rem[eé]dio caseiro|remedio caseiro|prescri[cç]|posologia|antibi[oó]tico|dipirona|paracetamol|ibuprofeno)/i.test(text)) violations.push('clinica');
  const hasPlaceholderBracket = /\[(?:link(?:_para)?_qr_code|qr_code|codigo_pix|c[oó]digo_pix|chave_pix|link_de_pagamento|inserir_[^\]]+)\]/i.test(text);
  const fakePixCodeMatch = text.match(/(?:c[oó]digo\s+pix|copia\s+e\s+cola)\s*:\s*`?([A-Za-z0-9._-]{4,40})`?/i);
  const hasFakePixCode = Boolean(
    fakePixCodeMatch
    && /\d/.test(fakePixCodeMatch[1])
    && !/^000201/.test(fakePixCodeMatch[1])
    && !text.includes('br.gov.bcb.pix')
  );
  const removedPaymentLink = linkCheck.removedCount > 0
    && /\b(?:pix|pagamento|checkout|c[oó]pia\s+e\s+cola|c[oó]digo\s+pix)\b/i.test(text);
  if (hasPlaceholderBracket || hasFakePixCode || removedPaymentLink) violations.push('pix_ficticio');
  const limit = maxLength || (isCopilot ? 4000 : 1200);
  if (text.length > limit) text = text.slice(0, limit).replace(/\s+\S*$/, '') + '…';

  return { text, violations: [...new Set(violations)], blocked: violations.length > 0 };
}

export function isAffirmative(text = '') {
  return new Set(['sim', 'pode', 'pode ser', 'quero', 'claro', 'com certeza', 'isso', 'ok', 'bora', 'manda', 'beleza']).has(normalize(text));
}

export function isGreeting(text = '') {
  const n = normalize(text);
  return n.split(' ').length <= 4 && new Set([
    'oi', 'ola', 'olaa', 'oie', 'bom dia', 'boa tarde', 'boa noite', 'opa', 'e ai', 'eae', 'tudo bem', 'tudo bom',
    'oi bom dia', 'ola bom dia', 'oi boa tarde', 'ola boa tarde', 'oi boa noite', 'ola boa noite'
  ]).has(n);
}

export function splitReply(text = '') {
  const value = String(text).trim();
  if (!value) return [];
  // Se houver código Pix EMV Copia e Cola (000201...br.gov.bcb.pix...), isola o código
  // em um balão próprio com crases triplas (bloco monoespaçado copiável no WhatsApp).
  const emvMatch = value.match(/(?:^|\n)(?:```)?(000201[^\s\n`]*br\.gov\.bcb\.pix[^\n`]{20,})(?:```)?(?=\n|$)/i);
  if (emvMatch && value !== `\`\`\`${emvMatch[1].trim()}\`\`\``) {
    const code = emvMatch[1].trim();
    const idx = value.indexOf(emvMatch[0]);
    const before = value.slice(0, idx).trim();
    const after = value.slice(idx + emvMatch[0].length).trim();
    const head = [before, after].filter(Boolean).join('\n\n').trim();
    const headParts = head ? splitReply(head) : [];
    return [...headParts, `\`\`\`${code}\`\`\``];
  }
  if (value.length <= 700) return [value];
  const paragraphs = value.split(/\n{2,}/).filter(Boolean);
  const parts = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > 700) {
      parts.push(current.trim());
      current = '';
    }
    if (paragraph.length > 700) {
      const sentences = paragraph.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (current && current.length + sentence.length + 1 > 700) {
          parts.push(current.trim());
          current = '';
        }
        current += `${sentence} `;
      }
    } else current += `${paragraph}\n\n`;
  }
  if (current.trim()) parts.push(current.trim());
  let result = parts.slice(0, 3);
  const total = result.join('').length;
  if (total > 1200) {
    result = result.map(part => part.slice(0, 400).replace(/\s+\S*$/, '') + '…').slice(0, 3);
  }
  return result;
}
