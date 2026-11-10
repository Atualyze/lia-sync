import { BUSINESS } from '../config.mjs';

/**
 * Identidade central da assistente.
 *
 * Nada aqui deve fixar nome de pessoa, empresa, apelidos ou telefone.
 * Tudo vem do painel (`botConfig.identity` e `botConfig.human.phone`), com
 * fallback neutro para que o mesmo código rode em qualquer operação.
 */

export const OWNER_SELF_KEY = 'tauan_self';

/**
 * Chaves internas aceitas pelo bridge/Chatwoot. `tauan_self` é o identificador
 * legado mantido por compatibilidade; os demais são aliases neutros.
 */
export const OWNER_SELF_ALIASES = Object.freeze([
  'tauan_self',
  'owner_self',
  'conv_lia_copilot',
  'contact_lia_copilot'
]);

export const NEUTRAL_IDENTITY = Object.freeze({
  botName: 'Lia',
  responsible: 'Equipe de Atendimento',
  companyName: '',
  language: 'pt-BR',
  tone: 'Acolhedor, dinâmico e bem distribuído. Use parágrafos curtos, quebras de linha para arejar a leitura, destaques em *negrito* nos pontos-chave e marcadores ("• ") quando listar opções.',
  aliases: Object.freeze([]),
  hours: BUSINESS.hours,
  areas: BUSINESS.areas,
  humanPhone: ''
});

const clean = value => (typeof value === 'string' ? value.trim() : '');

export function normalizeOwnerKey(value = '') {
  return String(value ?? '').trim().replace(/^sim:/i, '').toLowerCase();
}

export function isOwnerKey(value = '') {
  return OWNER_SELF_ALIASES.includes(normalizeOwnerKey(value));
}

export function digitsOf(value = '') {
  return String(value ?? '').replace(/@.*$/, '').replace(/\D/g, '');
}

export function normalizeName(value = '') {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Aceita tanto um `botConfig` completo quanto um objeto `identity`.
 */
export function resolveIdentity(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const isBotConfig = Boolean(source.identity || source.business || source.human || source.messages);
  const identity = isBotConfig ? (source.identity || {}) : source;
  const business = isBotConfig ? (source.business || {}) : (source.business || {});
  const human = isBotConfig ? (source.human || {}) : (source.human || {});

  const aliases = Array.isArray(identity.aliases)
    ? identity.aliases.map(clean).filter(Boolean)
    : [];

  return Object.freeze({
    botName: clean(identity.botName) || NEUTRAL_IDENTITY.botName,
    responsible: clean(identity.responsible) || clean(BUSINESS.responsible) || NEUTRAL_IDENTITY.responsible,
    companyName: clean(identity.companyName),
    language: clean(identity.language) || 'pt-BR',
    tone: clean(identity.tone) || NEUTRAL_IDENTITY.tone,
    aliases: Object.freeze([...new Set(aliases)]),
    hours: clean(business.hours) || clean(BUSINESS.hours) || NEUTRAL_IDENTITY.hours,
    areas: clean(business.areas) || clean(BUSINESS.areas) || NEUTRAL_IDENTITY.areas,
    humanPhone: clean(human.phone)
  });
}

/** Nomes pelos quais o responsável/empresa pode ser reconhecido no texto. */
export function identityNames(identity = {}) {
  const resolved = identity.responsible === undefined ? resolveIdentity(identity) : identity;
  return [...new Set([
    clean(resolved.responsible),
    clean(resolved.companyName),
    ...(Array.isArray(resolved.aliases) ? resolved.aliases.map(clean) : [])
  ].filter(Boolean))];
}

export function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex (sem acentos) que reconhece o responsável configurado, a empresa,
 * os apelidos e os termos neutros equivalentes.
 */
export function buildOwnerNamePattern(identity = {}) {
  const names = identityNames(identity)
    .sort((a, b) => b.length - a.length)
    .map(name => escapeRegExp(normalizeName(name)))
    .filter(Boolean);
  const neutral = ['responsavel', 'equipe', 'dono', 'diretor', 'diretoria', 'humano', 'atendente', 'pessoa'];
  return `(?:${[...names, ...neutral].join('|')})`;
}

/**
 * Detecta pedidos explícitos para falar com o responsável humano.
 * Menções casuais ("o Tauan me indicou") não devem disparar transbordo.
 */
export function isTalkToOwnerRequest(text = '', identity = {}) {
  const resolved = identity.responsible === undefined ? resolveIdentity(identity) : identity;
  const n = normalizeName(text);
  if (!n) return false;
  const who = buildOwnerNamePattern(resolved);

  const verbs = '(?:falar\\s+com|falar|passa|passar|transfere|transferir|chamar|chama|chame|quero|preciso|chamo|avisa|avisar|conectar|conversa|conversar)';
  const connectors = '(?:para\\s+|pra\\s+|pro\\s+|ao\\s+)?(?:com\\s+)?(?:o\\s+|a\\s+|um[a]?\\s+)?';

  return new RegExp(`${verbs}\\s+${connectors}${who}\\b`, 'i').test(n) ||
    new RegExp(`^(?:${who}|humano|atendente|pessoa|2|opcao 2)$`, 'i').test(n);
}

/**
 * Reconhece o contato do responsável (chat interno) por chave, nome ou telefone.
 *
 * Compatível com a assinatura antiga `isTauanContact(target, humanPhone, cachedOwner)`.
 *
 * @param {string} target
 * @param {string|object} options telefone humano (formato antigo) ou
 *        `{ humanPhone, cachedOwner, identity, names }`
 */
export function isOwnerContact(target = '', options = {}) {
  if (!target) return false;
  const opts = typeof options === 'string' ? { humanPhone: options } : (options || {});
  const raw = String(target).trim();
  if (isOwnerKey(raw)) return true;

  const identity = opts.identity
    ? (opts.identity.responsible === undefined ? resolveIdentity(opts.identity) : opts.identity)
    : null;
  const configuredNames = [
    ...(identity ? identityNames(identity) : []),
    ...(Array.isArray(opts.names) ? opts.names : [])
  ].map(normalizeName).filter(Boolean);

  const normalizedTarget = normalizeName(raw);
  if (normalizedTarget && configuredNames.includes(normalizedTarget)) return true;

  const targetDigits = digitsOf(raw);
  if (targetDigits.length < 8) return false;

  const candidates = [opts.humanPhone, opts.cachedOwner].filter(Boolean).map(digitsOf);
  for (const candidate of candidates) {
    if (!candidate || candidate.length < 8) continue;
    if (targetDigits === candidate) return true;

    const targetLast8 = targetDigits.slice(-8);
    const candidateLast8 = candidate.slice(-8);
    if (targetLast8 !== candidateLast8) continue;

    const targetDdd = targetDigits.startsWith('55') ? targetDigits.slice(2, 4) : (targetDigits.length >= 10 ? targetDigits.slice(0, 2) : '');
    const candidateDdd = candidate.startsWith('55') ? candidate.slice(2, 4) : (candidate.length >= 10 ? candidate.slice(0, 2) : '');
    if (!targetDdd || !candidateDdd || targetDdd === candidateDdd) return true;
  }

  return false;
}
