import { readBody, json, NOT_HANDLED, authorized } from './utils.mjs';
import { infinitePayOrders, checkInfinitePayPayment, normalizeHandle } from '../tools/gerenciar_cobranca_pagamento.mjs';
import { sendText as defaultSendText } from '../whatsapp.mjs';
import { OWNER_SELF_KEY } from '../core/identity.mjs';

function formatBrlFromCents(cents) {
  return `R$ ${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')}`;
}

/**
 * Segredo opcional do callback InfinitePay.
 * Quando configurado (env ou settings), a rota exige Bearer/token compatível.
 * Sem segredo, o callback é rejeitado: payment_check e comparação de valor são
 * camadas adicionais, não substitutos da autenticação do endpoint.
 */
export function resolveInfinitePayWebhookSecret(settings = {}) {
  return String(
    settings.webhookSecret
    || settings.webhookToken
    || process.env.INFINITEPAY_WEBHOOK_SECRET
    || process.env.INFINITEPAY_WEBHOOK_TOKEN
    || ''
  ).trim();
}

export function isInfinitePayCallbackAuthorized(req, secret = '') {
  const expected = String(secret || '').trim();
  if (!expected) return false;
  return authorized(req, expected);
}

/**
 * Metadados financeiros vêm só do payment_check e/ou do pedido armazenado.
 * Nunca de paid_amount / receipt_url / capture_method do callback.
 */
export function deriveVerifiedPaymentDetails(order = {}, check = {}) {
  const expectedCents = Number(order?.amountCents || 0);
  const verifiedCents = Number(check?.paidAmount || check?.amount || 0);
  if (expectedCents > 0 && verifiedCents > 0 && verifiedCents !== expectedCents) {
    return {
      ok: false,
      error: 'amount_mismatch',
      expectedCents,
      verifiedCents
    };
  }
  const paidAmountCents = verifiedCents > 0 ? verifiedCents : expectedCents;
  if (!(paidAmountCents > 0)) {
    return { ok: false, error: 'amount_unavailable', expectedCents, verifiedCents };
  }
  const captureMethod = String(check?.captureMethod || '').trim() || 'pix';
  return {
    ok: true,
    paidAmountCents,
    captureMethod,
    // payment_check não expõe comprovante confiável; nunca espelhar o callback.
    receiptUrl: ''
  };
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

  // Identificadores de consulta podem vir do callback (só para achar o pagamento),
  // mas valores/método/comprovante NÃO — isso sai do payment_check + pedido local.
  const transactionNsu = String(payload?.transaction_nsu || order.transactionNsu || '').trim();
  const slug = String(payload?.invoice_slug || payload?.slug || order.slug || '').trim();

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

      const verified = deriveVerifiedPaymentDetails(order, check);
      if (!verified.ok) {
        logger?.warn?.(
          `[infinitepay] Webhook para ${orderNsu} rejeitado (${verified.error}): esperado=${verified.expectedCents} verificado=${verified.verifiedCents}.`
        );
        return;
      }

      const { paidAmountCents, captureMethod, receiptUrl } = verified;

      const updated = orderStore.markPaid(orderNsu, {
        transactionNsu,
        slug,
        paidAmountCents,
        captureMethod,
        receiptUrl
      });

      const valorFmt = formatBrlFromCents(updated?.paidAmountCents || paidAmountCents);
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
            session.history.push({ role: 'assistant', content: clientMsg, createdAt: new Date().toISOString() });
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
          selfSession.history.push({ role: 'assistant', content: ownerMsg, createdAt: new Date().toISOString() });
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
  checkPayment = checkInfinitePayPayment,
  webhookSecret = resolveInfinitePayWebhookSecret()
}) {
  if (req.method !== 'POST' || u.pathname !== '/webhook/infinitepay') {
    return NOT_HANDLED;
  }
  if (!isInfinitePayCallbackAuthorized(req, webhookSecret)) {
    return json(res, 401, { ok: false, error: 'infinitepay_webhook_unauthorized' });
  }
  let payload;
  try {
    payload = await readBody(req);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json(res, 400, { ok: false, error: 'invalid_json' });
    }
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
