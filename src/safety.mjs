const tokens = (text = '') => normalize(text).split(/\s+/).filter(Boolean);

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
    `(?:[,\\s]+(?:sua\\s+)?(?:assistente|copiloto|atendente)[^.!?\n]*[.!?]+|[.!?\n]+)\\s*` +
    `(?:(?:como|em\\s+que)\\s+posso\\s+(?:te\\s+)?ajudar(?:\\s+hoje|\\s+agora)?[?!.\\s]*)?`,
    'i'
  );
  const stripped = raw.replace(introPattern, '').trim();
  if (stripped.length >= 12) {
    return stripped[0].toUpperCase() + stripped.slice(1);
  }
  return raw;
}

export function filterReply(reply = '', { allowedPrices = new Set(), isCopilot = false, maxLength, strictPrices = false, alreadyIntroduced = false, botName = 'Lia' } = {}) {
  let text = String(reply || '')
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
  if (value.length <= 700) return value ? [value] : [];
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
