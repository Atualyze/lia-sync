import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { getSafeInfinitePayCheckoutUrl } from '../payment-urls.mjs';

function tlv(id, value) {
  const str = String(value ?? '');
  const len = String(Buffer.byteLength(str, 'utf8')).padStart(2, '0');
  return `${id}${len}${str}`;
}

function sanitizeAscii(text, maxLen) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 .,-]/g, '')
    .trim()
    .slice(0, maxLen);
}

function crc16Ccitt(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function isValidCpf(digits) {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10) d1 = 0;
  if (d1 !== Number(digits[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(digits[i]) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10) d2 = 0;
  return d2 === Number(digits[10]);
}

export function normalizePixKey(rawKey, keyType = 'auto') {
  const raw = String(rawKey || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw.toLowerCase();

  const type = String(keyType || 'auto').trim().toLowerCase();
  const digits = raw.replace(/\D/g, '');
  if (type === 'telefone' || type === 'phone' || type === 'celular') {
    if (!digits) return raw;
    return digits.startsWith('55') && digits.length >= 12 ? `+${digits}` : `+55${digits}`;
  }
  if (type === 'cpf' || type === 'cnpj') return digits || raw;
  if (type === 'email' || type === 'aleatoria') return raw;

  if (raw.startsWith('+') && digits.length >= 10) return `+${digits}`;
  if (/[()]/.test(raw) && (digits.length === 10 || digits.length === 11)) return `+55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return `+${digits}`;
  if (digits.length === 11 && !isValidCpf(digits) && /^[1-9]{2}9\d{8}$/.test(digits)) {
    return `+55${digits}`;
  }
  if (digits.length === 10 && /^[1-9]{2}[2-8]\d{7}$/.test(digits)) {
    return `+55${digits}`;
  }
  return raw;
}

function cleanPixDescription(description) {
  const raw = sanitizeAscii(description, 40);
  if (!raw) return '';
  if (/^(?:preciso|quero|pode|gostaria\s+de|me)?\s*(?:gerar|criar|fazer|enviar|mandar)?\s*(?:um|uma)?\s*(?:cobranca\s*)?pix$/i.test(raw)) {
    return '';
  }
  return raw;
}

export function buildPixPayload({
  pixKey,
  keyType = 'auto',
  amount = 0,
  merchantName = 'Lia Sync',
  merchantCity = 'SAO PAULO',
  txid = '***',
  description = ''
} = {}) {
  const cleanKey = normalizePixKey(pixKey, keyType);
  if (!cleanKey) throw new Error('Chave Pix não informada.');

  const cleanName = sanitizeAscii(merchantName, 25) || 'Lia Sync';
  const cleanCity = sanitizeAscii(merchantCity, 15) || 'SAO PAULO';
  const cleanTxid = String(txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const cleanDesc = cleanPixDescription(description);

  const merchantAccount =
    tlv('00', 'br.gov.bcb.pix') +
    tlv('01', cleanKey) +
    (cleanDesc ? tlv('02', cleanDesc) : '');

  const numericAmount = Number(amount);
  const amountTag = Number.isFinite(numericAmount) && numericAmount > 0
    ? tlv('54', numericAmount.toFixed(2))
    : '';

  const base =
    tlv('00', '01') +
    tlv('26', merchantAccount) +
    tlv('52', '0000') +
    tlv('53', '986') +
    amountTag +
    tlv('58', 'BR') +
    tlv('59', cleanName) +
    tlv('60', cleanCity) +
    tlv('62', tlv('05', cleanTxid)) +
    '6304';

  return base + crc16Ccitt(base);
}


const DEFAULT_ORDERS_FILE = path.resolve(process.cwd(), 'data', 'infinitepay-orders.json');
const CHECKOUT_BASE_URL = 'https://api.checkout.infinitepay.io';

export class InfinitePayOrderStore {
  constructor(filePath = DEFAULT_ORDERS_FILE) {
    this.filePath = filePath;
    this.orders = new Map();
    this._loaded = false;
  }

  _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        for (const item of Array.isArray(raw) ? raw : []) {
          if (item?.orderNsu) this.orders.set(item.orderNsu, item);
        }
      }
    } catch {
      // fallback em memória se o disco ainda não existir
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const items = [...this.orders.values()].slice(-500);
      fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2), 'utf8');
    } catch {
      // falha de disco não bloqueia a operação em runtime
    }
  }

  recordOrder(order) {
    this._ensureLoaded();
    if (!order?.orderNsu) return null;
    const saved = { status: 'pending', createdAt: new Date().toISOString(), ...order };
    this.orders.set(saved.orderNsu, saved);
    this._persist();
    return saved;
  }

  getOrder(orderNsu) {
    this._ensureLoaded();
    return orderNsu ? this.orders.get(String(orderNsu)) || null : null;
  }

  findByShortCode(shortCode) {
    this._ensureLoaded();
    const code = String(shortCode || '').trim();
    if (!code) return null;
    return [...this.orders.values()].find(order => order.shortCode === code) || null;
  }

  findLatestByPhone(phone) {
    this._ensureLoaded();
    const target = String(phone || '').replace(/\D/g, '');
    if (!target) return null;
    const matches = [...this.orders.values()]
      .filter(o => String(o.phone || '').replace(/\D/g, '') === target)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return matches[0] || null;
  }

  markPaid(orderNsu, details = {}) {
    this._ensureLoaded();
    const existing = this.orders.get(String(orderNsu));
    if (!existing || existing.status === 'paid') return existing || null;
    const updated = {
      ...existing,
      ...details,
      status: 'paid',
      paidAt: details.paidAt || new Date().toISOString()
    };
    this.orders.set(updated.orderNsu, updated);
    this._persist();
    return updated;
  }
}


export class SupabaseInfinitePayOrderStore {
  constructor({ client, logger = console } = {}) { this.client = client; this.logger = logger; this.cache = new Map(); }
  _row(o = {}) { return { order_nsu: String(o.orderNsu || '').trim(), status: String(o.status || 'pending'), conversation_id: o.conversationId || null, phone: String(o.phone || '').slice(0, 32), client_name: String(o.clientName || '').slice(0, 160), payment_method: String(o.paymentMethod || 'checkout').slice(0, 40), amount_cents: Number(o.amountCents || 0), paid_amount_cents: Number(o.paidAmountCents || 0), description: String(o.description || '').slice(0, 160), handle: String(o.handle || '').slice(0, 120), checkout_url: String(o.checkoutUrl || '').slice(0, 1000), payment_url: String(o.paymentUrl || '').slice(0, 4000), slug: String(o.slug || '').slice(0, 160), transaction_nsu: String(o.transactionNsu || '').slice(0, 160), capture_method: String(o.captureMethod || '').slice(0, 40), created_at: o.createdAt || new Date().toISOString(), paid_at: o.paidAt || null, metadata: { actor: String(o.actor || 'system').slice(0, 40), installments: Number(o.installments || 0) || null, ...(o.shortCode ? { shortCode: String(o.shortCode).slice(0, 32) } : {}) } }; }
  _order(r) { if (!r) return null; return { orderNsu:r.order_nsu,status:r.status,conversationId:r.conversation_id,phone:r.phone,clientName:r.client_name,paymentMethod:r.payment_method,amountCents:r.amount_cents,paidAmountCents:r.paid_amount_cents,description:r.description,handle:r.handle,checkoutUrl:r.checkout_url,paymentUrl:r.payment_url,slug:r.slug,transactionNsu:r.transaction_nsu,captureMethod:r.capture_method,createdAt:r.created_at,paidAt:r.paid_at,...(r.metadata||{}) }; }
  async recordOrder(o) { if (!this.client?.enabled || !o?.orderNsu) return null; const rows=await this.client.upsert('payment_orders',[this._row(o)],'order_nsu'); const saved=this._order(rows?.[0]||this._row(o)); this.cache.set(saved.orderNsu,saved); return saved; }
  async getOrder(nsu) { const k=String(nsu||'').trim(); if(!k) return null; if(this.cache.has(k)) return this.cache.get(k); if(!this.client?.enabled) return null; const rows=await this.client.select('payment_orders',`select=*&order_nsu=eq.${encodeURIComponent(k)}&limit=1`); const v=this._order(rows?.[0]); if(v)this.cache.set(k,v); return v; }
  async findByShortCode(shortCode) { const code=String(shortCode||'').trim(); if(!code) return null; for(const cached of this.cache.values()) if(cached.shortCode===code) return cached; if(!this.client?.enabled) return null; const rows=await this.client.select('payment_orders',`select=*&metadata->>shortCode=eq.${encodeURIComponent(code)}&limit=1`); const v=this._order(rows?.[0]); if(v)this.cache.set(v.orderNsu,v); return v; }
  async findLatestByPhone(phone) { const d=String(phone||'').replace(/\D/g,''); if(!d||!this.client?.enabled)return null; const rows=await this.client.select('payment_orders',`select=*&phone=eq.${encodeURIComponent(d)}&order=created_at.desc&limit=1`); const v=this._order(rows?.[0]); if(v)this.cache.set(v.orderNsu,v); return v; }
  async markPaid(nsu,d={}) { const k=String(nsu||'').trim(); const old=await this.getOrder(k); if(!old||old.status==='paid')return old; const update={status:'paid',paid_amount_cents:Number(d.paidAmountCents||0),transaction_nsu:String(d.transactionNsu||old.transactionNsu||''),slug:String(d.slug||old.slug||''),capture_method:String(d.captureMethod||old.captureMethod||''),paid_at:d.paidAt||new Date().toISOString(),updated_at:new Date().toISOString()}; const rows=await this.client.patch('payment_orders',`order_nsu=eq.${encodeURIComponent(k)}&status=eq.pending`,update); const v=this._order(rows?.[0]||{...this._row(old),...update}); this.cache.set(k,v); return v; }
}

export const infinitePayOrders = new InfinitePayOrderStore();

export function normalizeHandle(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^\$+/, '');
}

export async function createInfinitePayLink({
  handle,
  apiKey = '',
  items = [],
  orderNsu,
  webhookUrl = '',
  redirectUrl = '',
  customer = null,
  options = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const cleanHandle = normalizeHandle(handle);
  if (!cleanHandle && !apiKey) {
    throw new Error('InfiniteTag (handle) da InfinitePay não configurada.');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Informe ao menos 1 item com valor maior que zero.');
  }
  const nsu = String(orderNsu || `LIA-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`);
  const body = {
    ...(cleanHandle ? { handle: cleanHandle } : {}),
    items: items.map(it => ({
      quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
      price: Math.max(1, Math.round(Number(it.price) || 0)),
      description: String(it.description || 'Pagamento').slice(0, 120)
    })),
    order_nsu: nsu,
    ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
    ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    ...(customer && (customer.name || customer.email || customer.phone_number) ? { customer } : {}),
    ...(apiKey && options ? { options } : {})
  };
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  const res = await fetchImpl(`${CHECKOUT_BASE_URL}/links`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Erro InfinitePay HTTP ${res.status}`);
  }
  const rawCheckoutUrl = data?.url || data?.checkout_url || data?.link || '';
  const checkoutUrl = getSafeInfinitePayCheckoutUrl(rawCheckoutUrl);
  if (!checkoutUrl) {
    throw new Error('InfinitePay não retornou uma URL de checkout HTTPS válida.');
  }
  return {
    checkoutUrl,
    orderNsu: nsu,
    slug: data?.slug || data?.invoice_slug || '',
    handle: cleanHandle,
    raw: data
  };
}

export async function checkInfinitePayPayment({
  handle,
  orderNsu,
  transactionNsu = '',
  slug = '',
  fetchImpl = globalThis.fetch
} = {}) {
  const cleanHandle = normalizeHandle(handle);
  if (!cleanHandle || !orderNsu) {
    throw new Error('Handle e order_nsu são obrigatórios para consultar pagamento.');
  }
  const res = await fetchImpl(`${CHECKOUT_BASE_URL}/payment_check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      handle: cleanHandle,
      order_nsu: String(orderNsu),
      ...(transactionNsu ? { transaction_nsu: String(transactionNsu) } : {}),
      ...(slug ? { slug: String(slug) } : {})
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Erro ao consultar InfinitePay HTTP ${res.status}`);
  }
  return {
    success: data?.success !== false,
    paid: data?.paid === true,
    amount: Number(data?.amount || 0),
    paidAmount: Number(data?.paid_amount || 0),
    installments: Number(data?.installments || 1),
    captureMethod: data?.capture_method || ''
  };
}



function parseAmountCents(value, { allowFree = false } = {}) {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!raw) return allowFree ? 0 : null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || (amount === 0 && !allowFree) || (amount > 0 && amount < 0.01)) return null;
  if (amount === 0) return 0;
  const cents = Math.round(amount * 100);
  return cents >= 1 ? cents : null;
}

function settingsFor(context = {}) {
  const unified = context?.botConfig?.tools?.settings?.gerenciar_cobranca_pagamento || {};
  const settings = { ...unified };
  return {
    ...settings,
    pixKey: String(settings.pixKey || '').trim(),
    pixKeyType: String(settings.pixKeyType || '').trim(),
    merchantName: String(settings.merchantName || '').trim(),
    merchantCity: String(settings.merchantCity || '').trim(),
    handle: normalizeHandle(settings.handle || ''),
    apiKey: String(settings.apiKey || '').trim(),
    paymentBaseUrl: String(settings.paymentBaseUrl || '').trim().replace(/\/$/, '')
  };
}

function paymentUrlFor({ baseUrl, payload, amountCents, merchantName, description, txid, checkoutUrl = '' }) {
  const params = new URLSearchParams({
    p: Buffer.from(payload, 'utf8').toString('base64url'),
    ...(amountCents > 0 ? { v: (amountCents / 100).toFixed(2) } : {}),
    n: merchantName,
    ...(description ? { d: description.slice(0, 80) } : {}),
    tx: txid,
    ...(checkoutUrl ? { c: checkoutUrl } : {})
  });
  return `${baseUrl}/pix?${params.toString()}`;
}

function createPaymentShortCode() {
  return crypto.randomBytes(12).toString('base64url');
}

function shortPaymentUrlFor({ baseUrl, shortCode }) {
  return `${baseUrl}/p/${shortCode}`;
}

export const toolGerenciarCobrancaPagamento = {
  name: 'gerenciar_cobranca_pagamento',
  description: 'Cria e verifica cobranças de pagamento configuráveis por Pix copia e cola, QR Code ou checkout InfinitePay. Use uma ação explícita: criar_pix, criar_checkout ou verificar_pagamento.',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: { type: 'STRING', enum: ['criar_pix', 'criar_checkout', 'criar_link', 'verificar_pagamento'], description: 'Ação explícita da cobrança.' },
      valor: { type: 'NUMBER', description: 'Valor em reais, com no máximo duas casas. Obrigatório para criar cobrança.' },
      valorLivre: { type: 'BOOLEAN', description: 'Permite Pix sem valor fixo somente quando solicitado explicitamente.' },
      descricao: { type: 'STRING', description: 'Descrição curta da cobrança.' },
      quantidade: { type: 'NUMBER', description: 'Quantidade de itens do checkout, padrão 1.' },
      chavePix: { type: 'STRING', description: 'Chave Pix configurada; só pode ser informada pelo responsável.' },
      enviarWhatsApp: { type: 'BOOLEAN', description: 'Enviar QR Code ao destino configurado.' },
      formato: { type: 'STRING', enum: ['chave_pix', 'copia_e_cola'], description: 'Formato escolhido pelo cliente para Pix.' },
      orderNsu: { type: 'STRING', description: 'Pedido a consultar.' },
      transactionNsu: { type: 'STRING', description: 'Identificador da transação.' },
      slug: { type: 'STRING', description: 'Slug da fatura.' }
    },
    required: []
  },
  async execute(args = {}, context = {}) {
    const settings = settingsFor(context);
    const requestedAction = String(args.acao || 'criar_pix').trim().toLowerCase();
    const action = requestedAction === 'criar_link' ? 'criar_checkout' : requestedAction;
    const orderStore = context?.infinitePayOrders || context?.store?.paymentOrderStore || infinitePayOrders;
    if (action === 'verificar_pagamento') {
      const requesterPhone = String(context?.targetPhone || context?.phone || context?.session?.phone || '').replace(/\D/g, '');
      let stored = null;
      if (context?.actor === 'client') {
        if (requesterPhone.length < 8) {
          return { success: false, error: 'order_nsu_not_found', message: 'Não encontrei um pedido para consultar neste atendimento.' };
        }
        const candidate = args.orderNsu
          ? await orderStore.getOrder(args.orderNsu)
          : await orderStore.findLatestByPhone(requesterPhone);
        const storedPhone = String(candidate?.phone || '').replace(/\D/g, '');
        if (!candidate || storedPhone !== requesterPhone) {
          // Resposta uniforme: não revela se o identificador de outro pedido existe.
          return { success: false, error: 'order_nsu_not_found', message: 'Não encontrei um pedido para consultar neste atendimento.' };
        }
        stored = candidate;
      } else {
        stored = args.orderNsu ? await orderStore.getOrder(args.orderNsu) : await orderStore.findLatestByPhone(requesterPhone);
      }
      const nsu = String(stored?.orderNsu || (context?.actor === 'client' ? '' : args.orderNsu) || '').trim();
      if (!nsu) return { success: false, error: 'order_nsu_not_found', message: 'Não encontrei um pedido para consultar.' };
      if (stored?.status === 'paid') return { success: true, action, paid: true, orderNsu: nsu, amount: stored.amountCents || 0, paidAmount: stored.paidAmountCents || stored.amountCents || 0, captureMethod: stored.captureMethod || 'pix' };
      const transactionNsu = context?.actor === 'client'
        ? (stored?.transactionNsu || '')
        : (args.transactionNsu || stored?.transactionNsu || '');
      const slug = context?.actor === 'client'
        ? (stored?.slug || '')
        : (args.slug || stored?.slug || '');
      const check = await checkInfinitePayPayment({ handle: stored?.handle || settings.handle, orderNsu: nsu, transactionNsu, slug, fetchImpl: context?.fetchImpl });
      const expected = Number(stored?.amountCents || 0);
      const paidAmount = Number(check.paidAmount || check.amount || 0);
      if (check.paid && expected > 0 && paidAmount !== expected) return { success: true, action, paid: false, error: 'amount_mismatch', orderNsu: nsu, expectedAmount: expected, paidAmount };
      if (check.paid) await orderStore.markPaid(nsu, { paidAmountCents: paidAmount || expected, captureMethod: check.captureMethod, installments: check.installments });
      return { success: true, action, orderNsu: nsu, ...check, paid: Boolean(check.paid && (!expected || paidAmount === expected)) };
    }

    const allowFreePix = action === 'criar_pix' && args.valorLivre === true;
    const amountCents = parseAmountCents(args.valor, { allowFree: allowFreePix });
    if (amountCents === null) return { success: false, error: 'invalid_amount', message: 'Informe um valor maior ou igual a R$ 0,01, com no máximo duas casas decimais.' };
    const description = String(args.descricao || 'Pagamento').trim().slice(0, 120);
    const merchantName = String(settings.merchantName).slice(0, 25);
    const merchantCity = String(settings.merchantCity).slice(0, 15);
    const isPix = action === 'criar_pix';
    if (!isPix && action !== 'criar_checkout') return { success: false, error: 'invalid_action', message: 'Ação de pagamento inválida.' };

    if (isPix) {
      const pixKey = String((context?.actor !== 'client' && args.chavePix) || settings.pixKey).trim();
      if (!pixKey) return { success: false, error: 'pix_key_not_configured', message: 'Chave Pix não configurada na ferramenta unificada.' };
      if (!settings.merchantName || !settings.merchantCity || !settings.paymentBaseUrl) {
        return { success: false, error: 'pix_settings_incomplete', message: 'Configure no banco o nome, a cidade e a URL pública da cobrança Pix.' };
      }
      const txid = String(args.txid || `LIA${Date.now().toString().slice(-8)}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
      const payload = buildPixPayload({ pixKey, keyType: settings.pixKeyType, amount: amountCents / 100, merchantName, merchantCity, txid, description });
      const dataUrl = await QRCode.toDataURL(payload, { width: 512, margin: 2 });
      const storedPaymentUrl = paymentUrlFor({ baseUrl: settings.paymentBaseUrl, payload, amountCents, merchantName, description, txid });
      const shortCode = createPaymentShortCode();
      const paymentUrl = shortPaymentUrlFor({ baseUrl: settings.paymentBaseUrl, shortCode });
      const rawTarget = String(context?.targetPhone || context?.phone || '').trim();
      const validTarget = Boolean(rawTarget) && rawTarget !== '__owner_self__' && (/@(?:s\.whatsapp\.net|lid|g\.us)$/i.test(rawTarget) || /^\d{8,15}$/.test(rawTarget.replace(/\D/g, '')));
      let qrCodeSent = false;
      if (args.enviarWhatsApp !== false && validTarget && context?.whatsapp?.sendImage) {
        try { await context.whatsapp.sendImage(rawTarget, { dataUrl, mimetype: 'image/png', caption: `💳 *QR Code Pix* - R$ ${(amountCents / 100).toFixed(2).replace('.', ',')}${description ? ` (${description.slice(0, 40)})` : ''}` }); qrCodeSent = true; } catch {}
      }
      await orderStore.recordOrder({ orderNsu: txid, phone: String(context?.targetPhone || context?.phone || '').replace(/\D/g, ''), clientName: context?.clientName || '', amountCents, description, paymentMethod: args.formato === 'chave_pix' ? 'pix_key' : 'pix_copy_paste', paymentUrl: storedPaymentUrl, shortCode, actor: context?.actor || 'client' });
      return { success: true, action, paymentMethod: args.formato === 'chave_pix' ? 'pix_key' : 'pix_copy_paste', ...(args.formato === 'chave_pix' ? { chavePix: pixKey } : { pixCopiaECola: payload, paymentUrl }), valor: amountCents / 100, amountCents, txid, favorecido: merchantName, qrCodeSent, ...(args.formato === 'chave_pix' ? {} : { qrCodeDataUrl: dataUrl }) };
    }

    if (!settings.handle && !settings.apiKey) return { success: false, error: 'infinitepay_not_configured', message: 'Configure o handle ou API Key do provedor na ferramenta unificada.' };
    const qty = Math.max(1, Math.round(Number(args.quantidade) || 1));
    const baseUrl = String(settings.publicBaseUrl || '').trim().replace(/\/webhook\/infinitepay\/?$/i, '').replace(/\/$/, '');
    const created = await createInfinitePayLink({ handle: settings.handle, apiKey: settings.apiKey, items: [{ quantity: qty, price: Math.round(amountCents), description }], orderNsu: context?.actor === 'client' ? undefined : args.orderNsu, webhookUrl: baseUrl ? `${baseUrl}/webhook/infinitepay` : '', redirectUrl: settings.redirectUrl || '', customer: null, options: settings.paymentMethodsEnabled ? { payment_methods_enabled: settings.paymentMethodsEnabled } : undefined, fetchImpl: context?.fetchImpl });
    const targetPhone = String(context?.targetPhone || context?.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
    let paymentUrl = created.checkoutUrl;
    let storedPaymentUrl = created.checkoutUrl;
    let shortCode = '';
    if (settings.pixKey) {
      const payload = buildPixPayload({ pixKey: settings.pixKey, keyType: settings.pixKeyType, amount: amountCents * qty / 100, merchantName, merchantCity, txid: created.orderNsu, description });
      storedPaymentUrl = paymentUrlFor({ baseUrl: settings.paymentBaseUrl, payload, amountCents: amountCents * qty, merchantName, description, txid: created.orderNsu, checkoutUrl: created.checkoutUrl });
      shortCode = createPaymentShortCode();
      paymentUrl = shortPaymentUrlFor({ baseUrl: settings.paymentBaseUrl, shortCode });
    }
    await orderStore.recordOrder({ orderNsu: created.orderNsu, handle: created.handle || settings.handle, slug: created.slug || '', checkoutUrl: created.checkoutUrl, paymentUrl: storedPaymentUrl, ...(shortCode ? { shortCode } : {}), phone: targetPhone.length >= 8 ? targetPhone : '', clientName: context?.clientName || '', amountCents: amountCents * qty, description, actor: context?.actor || 'owner', paymentMethod: 'checkout', conversationId: context?.session?._conversationId || null });
    return { success: true, action, checkoutUrl: created.checkoutUrl, paymentUrl, orderNsu: created.orderNsu, valor: (amountCents * qty) / 100, amountCents: amountCents * qty, descricao: description, handle: created.handle || settings.handle, webhookConfigured: Boolean(baseUrl) };
  }
};

export { parseAmountCents };
