import { FAQ, findFaqInItems } from './knowledge.mjs';

let cached = [...FAQ];
let cachedAt = 0;
let refreshing = null;

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

export function getPlansForPrompt() {
  return [];
}

export function plansToFaq(_plans = []) {
  return [{ question: 'planos', answer: 'cao e gatos' }];
}

export function getAllowedPrices() {
  return new Set();
}

export function faqAgeSeconds() {
  return cachedAt ? Math.floor((Date.now() - cachedAt) / 1000) : null;
}
