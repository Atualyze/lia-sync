import { readBody, json, NOT_HANDLED } from './utils.mjs';
import { infinitePayOrders, checkInfinitePayPayment, normalizeHandle } from '../tools/checkout_infinitepay.mjs';
import { sendText as defaultSendText } from '../whatsapp.mjs';
import { OWNER_SELF_KEY } from '../core/identity.mjs';

function formatBrlFromCents(cents) {
  return `R$ ${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')}`;
}

export async function processInfinitePayWebhook({
  payload = {},
  orderStore = infinitePayOrders,
  store = null,
  getHumanPhone = null,
  sendText = defaultSendText,
  checkPayment = checkInfinitePayPayment,
  logger = console
} = {}) {
  const orderNsu = String(payload?.order_nsu || '').trim();
  if (!orderNsu) {
    return { status: 400, body: { ok: false, error: 'missing_order_nsu' } };
  }
  const order = orderStore.getOrder(orderNsu);
  if (!order) {
    return { status: 400, body: { ok: false, error: 'unknown_order_nsu' } };
  }
  if (order.status === 'paid') {
    return { status: 200, body: { ok: true, alreadyProcessed: true, orderNsu } };
  }

  const transactionNsu = String(payload?.transaction_nsu || '').trim();
  const slug = String(payload?.invoice_slug || payload?.slug || order.slug || '').trim();
  const paidAmountCents = Number(payload?.paid_amount || payload?.amount || order.amountCents || 0);
  const captureMethod = String(payload?.capture_method || 'pix').trim();
  const receiptUrl = String(payload?.receipt_url || '').trim();

  const verifyAndNotify = async () => {
    try {
      const cleanHandle = normalizeHandle(order?.handle);
      if (!cleanHandle) {
        logger?.warn?.(`[infinitepay] Webhook recebido para ${orderNsu}, mas pedido não possui handle para verificação.`);
        return;
      }
      const check = await checkPayment({
        handle: cleanHandle,
        orderNsu,
        transactionNsu,
        slug
      });
      if (!check?.paid) {
        logger?.warn?.(`[infinitepay] Webhook recebido para ${orderNsu}, mas payment_check retornou paid=false.`);
        return;
      }

      const updated = orderStore.markPaid(orderNsu, {
        transactionNsu,
        slug,
        paidAmountCents,
        captureMethod,
        receiptUrl
      });

      const valorFmt = formatBrlFromCents(updated?.paidAmountCents || order.amountCents);
      const methodLabel = captureMethod === 'credit_card' ? 'Cartão de Crédito' : 'Pix';
      const clientPhone = String(order.phone || '').replace(/\D/g, '');

      if (clientPhone.length >= 8 && sendText) {
        const clientMsg = [
          `✅ *Pagamento confirmado!*`,
          `Recebemos seu pagamento de *${valorFmt}* via *${methodLabel}*${order.description ? ` (${order.description})` : ''}.`,
          receiptUrl ? `Comprovante: ${receiptUrl}` : ''
        ].filter(Boolean).join('\n\n');
        await sendText(clientPhone, clientMsg).catch(() => {});
        const session = store?.get?.(clientPhone);
        if (session) {
          if (session.pendingCheckout && session.pendingCheckout.orderNsu === orderNsu) {
            session.pendingCheckout.paidAt = new Date().toISOString();
          }
          const tags = Array.isArray(session.tags) ? session.tags.filter((t) => t !== 'checkout-pendente') : [];
          session.tags = Array.from(new Set([...tags, 'pagamento-confirmado'])).slice(0, 20);
          if (Array.isArray(session.history)) {
            session.history.push({ role: 'model', text: clientMsg });
          }
          store?.scheduleSave?.();
        }
      }

      const ownerPhone = String((typeof getHumanPhone === 'function' ? getHumanPhone() : '') || '').replace(/\D/g, '');
      if (ownerPhone.length >= 8 && ownerPhone !== clientPhone && sendText) {
        const who = order.clientName || (clientPhone ? `+${clientPhone}` : 'Cliente');
        const ownerMsg = [
          `💰 *Pagamento InfinitePay confirmado!*`,
          `• *Cliente:* ${who}`,
          `• *Valor:* ${valorFmt} (${methodLabel})`,
          order.description ? `• *Descrição:* ${order.description}` : '',
          `• *Pedido:* \`${orderNsu}\``,
          receiptUrl ? `• *Comprovante:* ${receiptUrl}` : ''
        ].filter(Boolean).join('\n');
        await sendText(ownerPhone, ownerMsg).catch(() => {});
        const selfSession = store?.get?.(OWNER_SELF_KEY);
        if (selfSession && Array.isArray(selfSession.history)) {
          selfSession.history.push({ role: 'model', text: ownerMsg });
          store?.scheduleSave?.();
        }
      }
    } catch (err) {
      logger?.error?.('[infinitepay] Falha ao confirmar webhook:', err?.message || err);
    }
  };

  const backgroundTask = verifyAndNotify();
  return { status: 200, body: { ok: true, received: true, orderNsu }, backgroundTask };
}

export async function handleInfinitePayWebhookRoute({
  req,
  res,
  u,
  store,
  getHumanPhone,
  orderStore = infinitePayOrders,
  sendText = defaultSendText,
  checkPayment = checkInfinitePayPayment
}) {
  if (req.method !== 'POST' || u.pathname !== '/webhook/infinitepay') {
    return NOT_HANDLED;
  }
  let payload;
  try {
    const raw = await readBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return json(res, 400, { ok: false, error: 'invalid_json' });
  }
  const result = await processInfinitePayWebhook({
    payload,
    orderStore,
    store,
    getHumanPhone,
    sendText,
    checkPayment
  });
  return json(res, result.status, result.body);
}
