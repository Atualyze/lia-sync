import test from 'node:test';
import assert from 'node:assert/strict';
import { isWebhookAuthorized, handleWebhookRoutes } from './webhook.mjs';
import { processInfinitePayWebhook } from './infinitepay-webhook.mjs';

test('ADVERSARIAL isWebhookAuthorized: matriz de tipos e retornos de webhookAuthorize', async () => {
  const req = { headers: {} };

  // Booleanos puros
  assert.equal(await isWebhookAuthorized(req, () => true), true, 'boolean true deve autorizar');
  assert.equal(await isWebhookAuthorized(req, () => false), false, 'boolean false deve negar');
  assert.equal(await isWebhookAuthorized(req, async () => true), true, 'async boolean true deve autorizar');
  assert.equal(await isWebhookAuthorized(req, async () => false), false, 'async boolean false deve negar');

  // Objetos { ok: boolean }
  assert.equal(await isWebhookAuthorized(req, () => ({ ok: true })), true, '{ ok: true } deve autorizar');
  assert.equal(await isWebhookAuthorized(req, () => ({ ok: false })), false, '{ ok: false } deve negar');
  assert.equal(await isWebhookAuthorized(req, async () => ({ ok: true })), true, 'async { ok: true } deve autorizar');
  assert.equal(await isWebhookAuthorized(req, async () => ({ ok: false })), false, 'async { ok: false } deve negar');

  // Tipos incorretos em .ok (deve exigir estritamente boolean true)
  assert.equal(await isWebhookAuthorized(req, () => ({ ok: 'true' })), false, 'string "true" não é booleano');
  assert.equal(await isWebhookAuthorized(req, () => ({ ok: 1 })), false, 'número 1 não é booleano');
  assert.equal(await isWebhookAuthorized(req, () => ({ ok: [] })), false, 'array não é booleano');
  assert.equal(await isWebhookAuthorized(req, () => ({ ok: {} })), false, 'objeto não é booleano');
  assert.equal(await isWebhookAuthorized(req, () => ({ ok: null })), false, 'null não é booleano');
  assert.equal(await isWebhookAuthorized(req, () => ({ ok: undefined })), false, 'undefined não é booleano');
  assert.equal(await isWebhookAuthorized(req, () => ({})), false, 'objeto vazio sem ok deve negar');

  // Primitivos e falsy / truthy genéricos
  assert.equal(await isWebhookAuthorized(req, () => null), false, 'null deve negar');
  assert.equal(await isWebhookAuthorized(req, () => undefined), false, 'undefined deve negar');
  assert.equal(await isWebhookAuthorized(req, () => 0), false, 'número 0 deve negar');
  assert.equal(await isWebhookAuthorized(req, () => 1), false, 'número 1 deve negar');
  assert.equal(await isWebhookAuthorized(req, () => ''), false, 'string vazia deve negar');
  assert.equal(await isWebhookAuthorized(req, () => 'authorized'), false, 'string truthy deve negar');
  assert.equal(await isWebhookAuthorized(req, () => NaN), false, 'NaN deve negar');
  assert.equal(await isWebhookAuthorized(req, () => []), false, 'array vazio deve negar');

  // Objetos congelados e com protótipos
  assert.equal(await isWebhookAuthorized(req, () => Object.freeze({ ok: false })), false, 'objeto congelado com ok:false deve negar');
  assert.equal(await isWebhookAuthorized(req, () => Object.freeze({ ok: true })), true, 'objeto congelado com ok:true deve autorizar');

  const protoOk = Object.create({ ok: true });
  protoOk.ok = false;
  assert.equal(await isWebhookAuthorized(req, () => protoOk), false, 'propriedade própria ok:false tem precedência');

  const protoFalse = Object.create({ ok: false });
  assert.equal(await isWebhookAuthorized(req, () => protoFalse), false, 'propriedade herdada ok:false deve negar');

  // Proxies e getters
  const throwingGetter = {
    get ok() {
      throw new Error('falha deliberada no getter');
    }
  };
  assert.equal(await isWebhookAuthorized(req, () => throwingGetter), false, 'getter que lança deve negar sem quebrar');

  const proxyOkFalse = new Proxy({}, {
    get(target, prop) {
      if (prop === 'ok') return false;
      return undefined;
    }
  });
  assert.equal(await isWebhookAuthorized(req, () => proxyOkFalse), false, 'proxy retornando ok:false deve negar');

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(await isWebhookAuthorized(req, () => revoked.proxy), false, 'proxy revogado deve negar');

  // Função que lança exceção
  assert.equal(await isWebhookAuthorized(req, () => { throw new Error('boom'); }), false, 'exceção direta deve negar');
  assert.equal(await isWebhookAuthorized(req, async () => { throw new Error('async boom'); }), false, 'rejeição async deve negar');
});

test('ADVERSARIAL handleWebhookRoutes: 401 garantido em payloads adversariais de autorização', async () => {
  const cases = [
    { name: '{ ok: false }', auth: () => ({ ok: false }) },
    { name: '{ ok: 0 }', auth: () => ({ ok: 0 }) },
    { name: '{ ok: "" }', auth: () => ({ ok: '' }) },
    { name: 'null', auth: () => null },
    { name: 'função que lança', auth: () => { throw new Error('auth error'); } },
    { name: 'objeto congelado ok:false', auth: () => Object.freeze({ ok: false }) }
  ];

  for (const tc of cases) {
    let statusCode = 0;
    let body = '';
    const res = {
      writeHead(code) { statusCode = code; },
      end(chunk) { body = String(chunk || ''); }
    };
    await handleWebhookRoutes({
      req: { method: 'POST', url: '/webhook/evolution', headers: {} },
      res,
      u: new URL('http://localhost/webhook/evolution'),
      webhookAuthorize: tc.auth
    });
    assert.equal(statusCode, 401, `Caso ${tc.name} deveria retornar status 401`);
    assert.match(body, /unauthorized/, `Caso ${tc.name} deveria ter corpo com erro unauthorized`);
  }
});

test('ADVERSARIAL processInfinitePayWebhook: pedidos sem handle NUNCA são marcados como pagos', async () => {
  class MockOrderStore {
    constructor() {
      this.orders = new Map();
    }
    setOrder(nsu, order) {
      this.orders.set(nsu, { status: 'pending', ...order });
    }
    getOrder(nsu) {
      return this.orders.get(nsu) || null;
    }
    markPaid(nsu, details) {
      const order = this.orders.get(nsu);
      if (!order) return null;
      order.status = 'paid';
      order.details = details;
      return order;
    }
  }

  const badHandleVariants = [
    { name: 'propriedade handle ausente', order: { orderNsu: 'NSU-1', amountCents: 1000 } },
    { name: 'handle string vazia', order: { orderNsu: 'NSU-2', handle: '', amountCents: 1000 } },
    { name: 'handle null', order: { orderNsu: 'NSU-3', handle: null, amountCents: 1000 } },
    { name: 'handle undefined', order: { orderNsu: 'NSU-4', handle: undefined, amountCents: 1000 } },
    { name: 'handle apenas espaços', order: { orderNsu: 'NSU-5', handle: '   ', amountCents: 1000 } },
    { name: 'handle número', order: { orderNsu: 'NSU-6', handle: 12345, amountCents: 1000 } },
    { name: 'handle objeto vazio', order: { orderNsu: 'NSU-7', handle: {}, amountCents: 1000 } },
    { name: 'handle Object.create(null)', order: { orderNsu: 'NSU-8', handle: Object.create(null), amountCents: 1000 } }
  ];

  for (const variant of badHandleVariants) {
    const store = new MockOrderStore();
    store.setOrder(variant.order.orderNsu, variant.order);

    let checkCalled = false;
    let sendCount = 0;
    const warnings = [];
    const logger = {
      warn(msg) { warnings.push(msg); },
      error() {}
    };

    const res = await processInfinitePayWebhook({
      payload: {
        order_nsu: variant.order.orderNsu,
        transaction_nsu: 'tx-test',
        paid_amount: 1000
      },
      orderStore: store,
      checkPayment: async () => {
        checkCalled = true;
        return { paid: true };
      },
      sendText: async () => {
        sendCount++;
      },
      logger
    });

    assert.equal(res.status, 200, `Resposta inicial deve acusar recebimento para ${variant.name}`);
    await res.backgroundTask;

    const saved = store.getOrder(variant.order.orderNsu);
    assert.equal(saved.status, 'pending', `Status DEVE permanecer pending para ${variant.name}`);
    assert.equal(checkCalled, false, `checkPayment NÃO pode ser chamado sem handle válido em ${variant.name}`);
    assert.equal(sendCount, 0, `Nenhuma mensagem pode ser disparada para ${variant.name}`);
    assert.ok(warnings.length > 0, `Warning deve ser registrado para ${variant.name}`);
  }
});

test('ADVERSARIAL processInfinitePayWebhook: quando checkPayment retorna paid:false ou lança erro', async () => {
  class MockOrderStore {
    constructor() {
      this.orders = new Map();
    }
    setOrder(nsu, order) {
      this.orders.set(nsu, { status: 'pending', ...order });
    }
    getOrder(nsu) {
      return this.orders.get(nsu) || null;
    }
    markPaid(nsu) {
      const order = this.orders.get(nsu);
      if (!order) return null;
      order.status = 'paid';
      return order;
    }
  }

  // Caso 1: checkPayment retorna paid: false
  {
    const store = new MockOrderStore();
    store.setOrder('ORDER-PAID-FALSE', { orderNsu: 'ORDER-PAID-FALSE', handle: 'valid-handle', phone: '5511999999999' });
    let sendCalled = false;
    const res = await processInfinitePayWebhook({
      payload: { order_nsu: 'ORDER-PAID-FALSE' },
      orderStore: store,
      checkPayment: async () => ({ paid: false }),
      sendText: async () => { sendCalled = true; }
    });
    assert.equal(res.status, 200);
    await res.backgroundTask;
    assert.equal(store.getOrder('ORDER-PAID-FALSE').status, 'pending');
    assert.equal(sendCalled, false);
  }

  // Caso 2: checkPayment lança exceção (ex: timeout de rede ou 500)
  {
    const store = new MockOrderStore();
    store.setOrder('ORDER-ERROR', { orderNsu: 'ORDER-ERROR', handle: 'valid-handle', phone: '5511999999999' });
    let sendCalled = false;
    const res = await processInfinitePayWebhook({
      payload: { order_nsu: 'ORDER-ERROR' },
      orderStore: store,
      checkPayment: async () => { throw new Error('API InfinitePay fora do ar'); },
      sendText: async () => { sendCalled = true; }
    });
    assert.equal(res.status, 200);
    await res.backgroundTask;
    assert.equal(store.getOrder('ORDER-ERROR').status, 'pending');
    assert.equal(sendCalled, false);
  }

  // Caso 3: checkPayment com sucesso confirma pagamento normalmente
  {
    const store = new MockOrderStore();
    store.setOrder('ORDER-VALID', { orderNsu: 'ORDER-VALID', handle: 'valid-handle', phone: '5511999999999', amountCents: 1500 });
    let sent = [];
    const res = await processInfinitePayWebhook({
      payload: { order_nsu: 'ORDER-VALID', transaction_nsu: 'tx-ok', paid_amount: 1500 },
      orderStore: store,
      checkPayment: async () => ({ paid: true, paidAmount: 1500, captureMethod: 'pix' }),
      sendText: async (phone, msg) => { sent.push({ phone, msg }); }
    });
    assert.equal(res.status, 200);
    await res.backgroundTask;
    assert.equal(store.getOrder('ORDER-VALID').status, 'paid');
    assert.ok(sent.length >= 1);
  }
});
