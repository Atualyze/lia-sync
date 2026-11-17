import { FAQ, findFaqInItems } from './knowledge.mjs';
import { normalize, detectPriceMentions } from './safety.mjs';

let cached = [...FAQ];
let cachedAt = 0;
let refreshing = null;

// Fonte canônica de preços/planos (configuração publicada). Injetada pelo servidor.
let pricingSource = null;
const MAX_PRICING_ITEMS = 200;
const MAX_SCAN_NODES = 5000;

/**
 * Define a fonte da configuração publicada usada para derivar preços e planos.
 * `server.mjs` injeta `() => adminConfig.active`. Sem fonte, preços/planos são vazios
 * e o caminho de cliente opera fail-closed (nenhum valor específico é confirmado).
 */
export function setPricingSource(fn) {
  pricingSource = typeof fn === 'function' ? fn : null;
}

function pricingSnapshot() {
  if (!pricingSource) return null;
  try {
    const snapshot = pricingSource();
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  } catch {
    return null;
  }
}

/** Varredura profunda e limitada de todas as strings do objeto de configuração. */
function collectStrings(root) {
  const out = [];
  const seen = new WeakSet();
  const stack = [root];
  let budget = MAX_SCAN_NODES;
  while (stack.length && budget-- > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === 'string') {
      if (current) out.push(current);
      continue;
    }
    if (typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const value of Object.values(current)) stack.push(value);
  }
  return out;
}

/** Varredura profunda e limitada das listas de planos presentes na configuração. */
function collectPlans(root) {
  const plans = [];
  const seen = new WeakSet();
  const stack = [root];
  let budget = MAX_SCAN_NODES;
  while (stack.length && budget-- > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      const candidates = current.filter(item => item && typeof item === 'object' && !Array.isArray(item));
      for (const item of candidates) {
        if (typeof item.name === 'string' || typeof item.title === 'string') plans.push(item);
      }
      for (const item of current) stack.push(item);
      continue;
    }
    if (Array.isArray(current.plans)) {
      for (const item of current.plans) {
        if (item && typeof item === 'object' && !Array.isArray(item)) plans.push(item);
      }
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  const unique = new Map();
  for (const plan of plans) {
    const key = `${plan.name || plan.title || ''}|${plan.price || plan.valor || ''}`;
    if (!unique.has(key)) unique.set(key, plan);
  }
  return [...unique.values()];
}

function speciesLabel(value) {
  const n = normalize(value);
  if (!n) return '';
  const hasCat = /\bgatos?\b/.test(n) || /\bfelin[oa]s?\b/.test(n);
  const hasDog = /\bca(?:o|es|es)\b/.test(n) || /\bcachorros?\b/.test(n) || /\bcanin[oa]s?\b/.test(n);
  if (hasCat && !hasDog) return 'gatos';
  if (hasDog && !hasCat) return 'caes';
  return 'cao e gatos';
}

function planText(plan = {}) {
  const name = text(plan.name ?? plan.title);
  const price = text(plan.price ?? plan.valor ?? plan.value);
  const description = text(plan.description ?? plan.descricao ?? plan.summary);
  const species = speciesLabel(plan.pet_species ?? plan.species ?? plan.especie ?? plan.pets ?? '');
  if (!name) return null;
  const details = [
    price ? `*Valor:* ${price}` : '',
    description ? `*Descrição:* ${description}` : '',
    species ? `*Atende:* ${species}` : ''
  ].filter(Boolean);
  const answer = [`Plano *${name}*`, details.join(' • ')].filter(Boolean).join(' — ');
  const keys = [...new Set([`plano ${normalize(name)}`, normalize(name)].filter(Boolean))];
  return { keys, answer };
}

export function getAllowedPrices() {
  const snapshot = pricingSnapshot();
  if (!snapshot) return new Set();
  const prices = new Set();
  for (const value of collectStrings(snapshot)) {
    for (const mention of detectPriceMentions(value)) {
      const normalizedPrice = mention.raw.replace(/\s/g, '');
      if (!normalizedPrice) continue;
      prices.add(normalizedPrice);
      if (prices.size >= MAX_PRICING_ITEMS) return prices;
    }
  }
  return prices;
}

const text = v => typeof v === 'string' ? v.trim() : '';

const list = v => {
  const a = Array.isArray(v) ? v : v?.faq;
  return Array.isArray(a)
    ? a.filter(i => i?.active !== false && i?.enabled !== false).map(i => ({
        keys: [i?.question, ...(i?.keys || [])].map(text).filter(Boolean),
        answer: text(i?.answer)
      })).filter(i => i.keys.length && i.answer)
    : [];
};

async function get(name, params) {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!process.env.SUPABASE_URL || !key) return [];
  const u = new URL(`/rest/v1/${name}`, process.env.SUPABASE_URL);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw Error(`${name} ${r.status}`);
  return r.json();
}

async function refresh() {
  const remote = [];
  if (process.env.FAQ_URL) {
    try {
      const r = await fetch(process.env.FAQ_URL, { signal: AbortSignal.timeout(8000) });
      if (r.ok) remote.push(...list(await r.json()));
    } catch (e) {
      console.error('[faq] remoto:', e.message);
    }
  }

  const [faqRows, settings] = await Promise.allSettled([
    get('faq', { select: 'question,keys,answer,active,sort_order', active: 'eq.true', order: 'sort_order.asc' }),
    get('workspace_settings', { select: 'aeo_faq', limit: '1' })
  ]);

  if (faqRows.status === 'fulfilled') remote.unshift(...list(faqRows.value));
  if (settings.status === 'fulfilled') remote.unshift(...list(settings.value?.[0]?.aeo_faq));

  if (remote.length) {
    cached = [...remote, ...FAQ];
  } else {
    cached = [...FAQ];
  }
  cachedAt = Date.now();
}

export async function loadFaq() {
  const ttl = Number(process.env.FAQ_CACHE_SECONDS || 60) * 1000;
  if (Date.now() - cachedAt < ttl) return cached;
  if (!refreshing) {
    refreshing = refresh().catch(e => console.error('[faq]', e.message)).finally(() => { refreshing = null; });
  }
  if (cached && cached.length > 0 && cachedAt > 0) return cached;
  await refreshing;
  return cached;
}

export function findDynamicFaq(t, items = cached) {
  return findFaqInItems(t, items);
}

/** Planos publicados, em formato enxuto para o prompt da IA. */
export function getPlansForPrompt() {
  const snapshot = pricingSnapshot();
  if (!snapshot) return [];
  return collectPlans(snapshot).slice(0, 50).map(plan => ({
    name: text(plan.name ?? plan.title),
    price: text(plan.price ?? plan.valor ?? plan.value),
    description: text(plan.description ?? plan.descricao ?? plan.summary),
    species: speciesLabel(plan.pet_species ?? plan.species ?? plan.especie ?? plan.pets ?? '')
  })).filter(plan => plan.name);
}

/** Converte planos reais em itens de FAQ coerentes (chave + resposta com valores). */
export function plansToFaq(plans = []) {
  if (!Array.isArray(plans)) return [];
  return plans.map(planText).filter(Boolean);
}

export function faqAgeSeconds() {
  return cachedAt ? Math.floor((Date.now() - cachedAt) / 1000) : null;
}
