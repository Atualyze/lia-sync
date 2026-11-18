const INFINITEPAY_CHECKOUT_HOSTS = new Set([
  'checkout.infinitepay.io',
  'pay.infinitepay.io'
]);

export function getSafeInfinitePayCheckoutUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    if (!INFINITEPAY_CHECKOUT_HOSTS.has(url.hostname.toLowerCase())) return '';
    if (url.username || url.password || url.port) return '';
    return url.href;
  } catch {
    return '';
  }
}
