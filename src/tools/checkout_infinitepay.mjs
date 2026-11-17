import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
    if (!existing) return null;
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
  const checkoutUrl = data?.url || data?.checkout_url || data?.link || '';
  if (!checkoutUrl) {
    throw new Error('InfinitePay não retornou a URL de checkout.');
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

export const toolCheckoutInfinitePay = {
  name: 'checkout_infinitepay',
  description:
    'Gera link de pagamento oficial InfinitePay (Pix e Cartão) com confirmação automática por webhook e consulta status de pagamento em tempo real.',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: {
        type: 'STRING',
        description: 'criar_link (padrão) ou verificar_pagamento.'
      },
      valor: {
        type: 'NUMBER',
        description: 'Valor em reais (ex: 150.00). Obrigatório para criar_link.'
      },
      descricao: {
        type: 'STRING',
        description: 'Descrição do produto ou serviço.'
      },
      quantidade: {
        type: 'NUMBER',
        description: 'Quantidade de itens (padrão 1).'
      },
      orderNsu: {
        type: 'STRING',
        description: 'ID do pedido para verificar_pagamento (opcional).'
      },
      transactionNsu: {
        type: 'STRING',
        description: 'transaction_nsu recebido após pagamento (opcional).'
      },
      slug: {
        type: 'STRING',
        description: 'Código da fatura InfinitePay (opcional).'
      }
    },
    required: []
  },
  async execute(args = {}, context = {}) {
    const settings = context?.botConfig?.tools?.settings?.checkout_infinitepay || {};
    const pixSettings = context?.botConfig?.tools?.settings?.gerar_cobranca_pix || {};
    const handle = normalizeHandle(settings.handle || process.env.INFINITEPAY_HANDLE || '');
    const apiKey = String(settings.apiKey || process.env.INFINITEPAY_API_KEY || '').trim();
    const orderStore = context?.infinitePayOrders || infinitePayOrders;
    const action = String(args.acao || 'criar_link').trim().toLowerCase();

    if (!handle && !apiKey) {
      return {
        success: false,
        error: 'infinitepay_not_configured',
        message: 'InfiniteTag (handle) da InfinitePay não configurada em Ferramentas → checkout_infinitepay.'
      };
    }

    if (action === 'verificar_pagamento') {
      const targetPhone = context?.targetPhone || context?.phone;
      const stored = args.orderNsu
        ? orderStore.getOrder(args.orderNsu)
        : orderStore.findLatestByPhone(targetPhone);
      const nsu = String(args.orderNsu || stored?.orderNsu || '').trim();
      if (!nsu) {
        return {
          success: false,
          error: 'order_nsu_not_found',
          message: 'Não encontrei nenhum pedido InfinitePay recente para consultar. Me informe o código do pedido (order_nsu).'
        };
      }
      if (stored?.status === 'paid') {
        return {
          success: true,
          action: 'verificar_pagamento',
          paid: true,
          orderNsu: nsu,
          amount: stored.amountCents || 0,
          paidAmount: stored.paidAmountCents || stored.amountCents || 0,
          captureMethod: stored.captureMethod || 'pix',
          receiptUrl: stored.receiptUrl || ''
        };
      }
      const check = await checkInfinitePayPayment({
        handle: stored?.handle || handle,
        orderNsu: nsu,
        transactionNsu: args.transactionNsu || stored?.transactionNsu || '',
        slug: args.slug || stored?.slug || '',
        fetchImpl: context?.fetchImpl
      });
      if (check.paid) {
        orderStore.markPaid(nsu, {
          paidAmountCents: check.paidAmount,
          captureMethod: check.captureMethod,
          installments: check.installments
        });
      }
      return {
        success: true,
        action: 'verificar_pagamento',
        orderNsu: nsu,
        ...check
      };
    }

    const valor = Number(String(args.valor ?? '').replace(',', '.'));
    if (!Number.isFinite(valor) || valor <= 0) {
      return {
        success: false,
        error: 'invalid_amount',
        message: 'Informe um valor maior que zero para gerar o link InfinitePay.'
      };
    }
    const priceCents = Math.round(valor * 100);
    const qty = Math.max(1, Math.round(Number(args.quantidade) || 1));
    const description = String(args.descricao || 'Pagamento').trim().slice(0, 120);
    const baseUrl = String(
      settings.publicBaseUrl ||
      pixSettings.publicBaseUrl ||
      process.env.PUBLIC_BASE_URL ||
      process.env.DASHBOARD_ORIGIN ||
      ''
    ).trim().replace(/\/webhook\/infinitepay\/?$/i, '').replace(/\/$/, '');
    const webhookUrl = baseUrl ? `${baseUrl}/webhook/infinitepay` : '';
    const redirectUrl = String(settings.redirectUrl || '').trim();

    const targetPhone = String(context?.targetPhone || context?.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
    const customer = (context?.clientName || targetPhone.length >= 8) ? {
      ...(context?.clientName ? { name: String(context.clientName).slice(0, 80) } : {}),
      ...(targetPhone.length >= 10 ? { phone_number: targetPhone.startsWith('55') ? `+${targetPhone}` : `+55${targetPhone}` } : {})
    } : null;

    const created = await createInfinitePayLink({
      handle,
      apiKey,
      items: [{ quantity: qty, price: priceCents, description }],
      orderNsu: args.orderNsu,
      webhookUrl,
      redirectUrl,
      customer,
      fetchImpl: context?.fetchImpl
    });

    orderStore.recordOrder({
      orderNsu: created.orderNsu,
      handle: created.handle || handle,
      slug: created.slug || '',
      checkoutUrl: created.checkoutUrl,
      phone: targetPhone.length >= 8 ? targetPhone : '',
      clientName: context?.clientName || '',
      amountCents: priceCents * qty,
      description,
      actor: context?.actor || 'owner'
    });

    return {
      success: true,
      action: 'criar_link',
      checkoutUrl: created.checkoutUrl,
      orderNsu: created.orderNsu,
      valor: Number(((priceCents * qty) / 100).toFixed(2)),
      descricao: description,
      handle: created.handle || handle,
      webhookConfigured: Boolean(webhookUrl)
    };
  }
};
