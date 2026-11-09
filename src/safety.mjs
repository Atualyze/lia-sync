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
 * Sintomas veterinários de alto risco.
 * Qualquer menção a estes termos deve ser tratada como emergência clínica:
 * handoff imediato e encaminhamento para atendimento presencial.
 */
const HIGH_RISK_SYMPTOM_PATTERNS = [
  /\bsangr/,                          // sangrando, sangramento, sangue
  /\bconvuls/,                        // convulsão, convulsionando
  /\bveneno/,                         // veneno, envenenado
  /\benvenen/,                        // envenenamento
  /\bintoxic/,                        // intoxicação
  /\batropel/,                        // atropelado, atropelamento
  /\bdesmai/,                         // desmaiou, desmaio
  /\bfalta de ar\b/,
  /\bn[aã]o respira/,
  /\brespira(?:ndo)? (?:mal|com dificuldade)/,
  /\bdificuldade para respirar/,
  /\bn[aã]o consegue (?:levantar|andar|se levantar)/,
  /\bparalis/,                        // paralisia, paralisado
  /\bsem movimento/,
  /\bn[aã]o (?:acorda|reage)/,
  /\bvomit\w* (?:com )?sangue/,
  /\bdiarreia (?:com )?sangue/,
  /\bengol(?:iu|ido|iu)? (?:algo|objeto|corpo)/,
  /\bpernas? (?:traseira|dianteira)s? (?:n[aã]o|paralis)/,
  /\bgolpe de calor/,
  /\binchad[oa]\b.*\b(?:barriga|abdome)/,
  /\bmorrendo\b/,
  /\bmorreu\b/,
  /\bgravid[ae].*\b(?:sangr|dor forte)/
];

export function isHighRiskSymptom(text = '') {
  const n = normalize(text);
  return HIGH_RISK_SYMPTOM_PATTERNS.some(p => p.test(n));
}

/**
 * Filtro de urgência/emergência geral ou pedido crítico de atendimento
 */
export function isEmergency(text = '') {
  const n = normalize(text);
  const patterns = [
    /\burgente\b/,
    /\burgencia\b/,
    /\bsocorro\b/,
    /\bgolpe\b/,
    /\bfraude\b/,
    /\binvasao\b/,
    /\bprocesso judicial\b/,
    /\bameaca\b/
  ];
  if (patterns.some(p => has(n, p))) return true;
  return isHighRiskSymptom(text);
}

/**
 * Identifica se a dúvida requer atenção especializada ou detalhamento técnico
 */
export function isClinicalConcern(text = '') {
  const n = normalize(text);
  return /\b(problema grave|reclamacao|reclamação|procon|estorno|cancelamento imediato)\b/.test(n);
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

const price = /R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+\s?reais/gi;

export function filterReply(reply = '', { allowedPrices = new Set(), isCopilot = false, maxLength } = {}) {
  let text = String(reply || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
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

  const violations = [];

  const allowedCents = new Set();
  for (const p of allowedPrices) {
    const c = parsePriceToCents(p);
    if (c !== null) allowedCents.add(c);
    allowedCents.add(String(p).replace(/\s/g, '').toLowerCase());
  }

  // Se houver preços permitidos cadastrados e não for mensagem de copiloto, bloqueia preços alucinados
  if (allowedPrices && allowedPrices.size > 0 && !isCopilot) {
    for (const value of text.match(price) || []) {
      const normalizedValue = value.replace(/\s/g, '').toLowerCase();
      const valueCents = parsePriceToCents(value);
      const isAllowed = allowedPrices.has(value.replace(/\s/g, '')) ||
        (valueCents !== null && allowedCents.has(valueCents));
      if (!isAllowed) violations.push('preco');
    }
  }

  if (/100% garantid[oa]|cura milagrosa|fique rico/i.test(text)) violations.push('absoluto');
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
