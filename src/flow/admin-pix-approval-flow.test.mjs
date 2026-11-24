import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createFlow } from '../flow.mjs';
import { SessionStore } from '../sessions.mjs';
import { OWNER_SELF_KEY } from '../core/identity.mjs';

const ADMIN_PHONE = '5588998340085';
const CLIENT_PHONE = '5588999991111';

function createBotConfig() {
  return {
    identity: {
      assistantName: 'Lia',
      ownerName: 'Tauan',
      companyName: 'Atualyze'
    },
    ai: {
      agentMode: 'super_agente',
      enableToolCalling: true
    },
    tools: {
      enabled: { gerenciar_cobranca_pagamento: true },
      settings: {
        gerenciar_cobranca_pagamento: {
          pixKey: 'pix-test@atualyze.com.br',
          merchantName: 'Atualyze',
          merchantCity: 'Sobral',
          paymentBaseUrl: 'https://pay.example.test'
        }
      }
    }
  };
}

function pendingDecision(amount = 5, requestId = undefined) {
  return {
    type: 'pix_generation',
    status: 'pending',
    ...(requestId ? { requestId } : {}),
    amount,
    description: 'Pagamento via Pix',
    paymentMethod: 'pix_copy_paste',
    requestedAt: new Date().toISOString()
  };
}

test('cliente: resposta normal da IA não libera Pix; valor informado exige decisão administrativa', async () => {
  const sent = [];
  const store = new SessionStore(path.join(os.tmpdir(), `lia-admin-pix-client-${Date.now()}.json`));
  let aiCalls = 0;
  const flow = createFlow({
    store,
    getBotConfig: createBotConfig,
    getHumanPhone: () => ADMIN_PHONE,
    whatsapp: {
      sendText: async (phone, text) => { sent.push({ phone, text }); }
    },
    ai: {
      askAI: async () => {
        aiCalls += 1;
        return aiCalls === 1
          ? { reply: 'Qual é o valor para eu gerar o código copia e cola?', tool_calls: [] }
          : { reply: 'Certo, vou gerar o código para você.', tool_calls: [{ name: 'gerenciar_cobranca_pagamento', args: { valor: 5 } }] };
      }
    },
    logger: { log() {}, warn() {}, error() {} }
  });

  const first = await flow.process({
    phone: CLIENT_PHONE,
    text: 'Quero o código copia e cola',
    origin: 'client'
  });
  assert.match(first, /valor/i);
  assert.equal(store.get(CLIENT_PHONE).pendingClientPayment.choice, 'pix');

  const second = await flow.process({
    phone: CLIENT_PHONE,
    text: '5',
    origin: 'client'
  });
  const customer = store.get(CLIENT_PHONE);
  const ownerNotice = sent.find(item => item.phone === ADMIN_PHONE);

  assert.match(second, /ainda não gerei o Pix/i);
  assert.equal(customer.pendingAdminDecision.status, 'pending');
  assert.equal(customer.pendingAdminDecision.amount, 5);
  assert.match(customer.pendingAdminDecision.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(customer.human, true);
  assert.ok(ownerNotice);
  assert.match(ownerNotice.text, /DECISÃO NECESSÁRIA/i);
  assert.match(ownerNotice.text, /GERAR PIX/);
  assert.match(ownerNotice.text, /ASSUMIR ATENDIMENTO/);
  assert.ok(ownerNotice.text.includes(customer.pendingAdminDecision.requestId));
  assert.equal(sent.some(item => item.phone === CLIENT_PHONE), false);
});

test('Copiloto: GERAR PIX explícito envia o código ao cliente e retoma a Lia', async () => {
  const sentTexts = [];
  const sentImages = [];
  const store = new SessionStore(path.join(os.tmpdir(), `lia-admin-pix-generate-${Date.now()}.json`));
  const customer = store.get(CLIENT_PHONE);
  customer.clientName = 'Ana';
  customer.human = true;
  customer.humanSource = 'admin';
  customer.pendingClientPayment = { args: {}, choice: 'pix', createdAt: new Date().toISOString() };
  customer.pendingAdminDecision = pendingDecision(5);

  const flow = createFlow({
    store,
    getBotConfig: createBotConfig,
    getHumanPhone: () => ADMIN_PHONE,
    whatsapp: {
      sendText: async (phone, text) => { sentTexts.push({ phone, text }); },
      sendImage: async (phone, image) => { sentImages.push({ phone, image }); }
    },
    ai: { askAI: async () => ({ reply: 'Não deveria precisar consultar a IA.', tool_calls: [] }) },
    logger: { log() {}, warn() {}, error() {} }
  });

  const reply = await flow.process({
    phone: OWNER_SELF_KEY,
    text: 'GERAR PIX',
    origin: 'owner'
  });

  assert.match(reply, /gerei e enviei o Pix copia e cola/i);
  assert.equal(sentImages.length, 1);
  assert.equal(sentImages[0].phone, CLIENT_PHONE);
  assert.equal(sentTexts.length, 1);
  assert.equal(sentTexts[0].phone, CLIENT_PHONE);
  assert.match(sentTexts[0].text, /R\$ 5,00/);
  assert.match(sentTexts[0].text, /Copia e Cola/);
  assert.match(sentTexts[0].text, /000201/);
  assert.equal(customer.pendingAdminDecision.status, 'completed');
  assert.equal(customer.pendingClientPayment, null);
  assert.equal(customer.human, false);
});

test('Copiloto: ASSUMIR ATENDIMENTO mantém modo humano e não chama ferramenta Pix', async () => {
  const sentTexts = [];
  const sentImages = [];
  const store = new SessionStore(path.join(os.tmpdir(), `lia-admin-pix-assume-${Date.now()}.json`));
  const customer = store.get(CLIENT_PHONE);
  customer.clientName = 'Ana';
  customer.human = true;
  customer.pendingClientPayment = { args: {}, choice: 'pix', createdAt: new Date().toISOString() };
  customer.pendingAdminDecision = pendingDecision(5);

  const flow = createFlow({
    store,
    getBotConfig: createBotConfig,
    whatsapp: {
      sendText: async (phone, text) => { sentTexts.push({ phone, text }); },
      sendImage: async (phone, image) => { sentImages.push({ phone, image }); }
    },
    ai: { askAI: async () => ({ reply: 'Não deveria precisar consultar a IA.', tool_calls: [] }) },
    logger: { log() {}, warn() {}, error() {} }
  });

  const reply = await flow.process({
    phone: OWNER_SELF_KEY,
    text: 'ASSUMIR ATENDIMENTO',
    origin: 'owner'
  });

  assert.match(reply, /você assumiu o atendimento/i);
  assert.equal(customer.pendingAdminDecision.status, 'assumed');
  assert.equal(customer.pendingClientPayment, null);
  assert.equal(customer.human, true);
  assert.equal(customer.humanSource, 'admin');
  assert.equal(sentTexts.length, 0);
  assert.equal(sentImages.length, 0);
});

test('Copiloto: mais de uma cobrança pendente exige identificar o cliente', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `lia-admin-pix-multiple-${Date.now()}.json`));
  const ana = store.get(CLIENT_PHONE);
  ana.clientName = 'Ana';
  ana.pendingAdminDecision = pendingDecision(5);
  const brunaPhone = '5588999992222';
  const bruna = store.get(brunaPhone);
  bruna.clientName = 'Bruna';
  bruna.pendingAdminDecision = pendingDecision(10);

  const flow = createFlow({
    store,
    getBotConfig: createBotConfig,
    ai: { askAI: async () => ({ reply: 'Não deveria chamar a IA.', tool_calls: [] }) },
    logger: { log() {}, warn() {}, error() {} }
  });

  const reply = await flow.process({
    phone: OWNER_SELF_KEY,
    text: 'GERAR PIX',
    origin: 'owner'
  });

  assert.match(reply, /mais de uma cobrança/i);
  assert.match(reply, /Ana/);
  assert.match(reply, /Bruna/);
  assert.equal(ana.pendingAdminDecision.status, 'pending');
  assert.equal(bruna.pendingAdminDecision.status, 'pending');
});


test('Copiloto: ID do botão escolhe o cliente exato mesmo com várias cobranças pendentes', async () => {
  const sentTexts = [];
  const sentImages = [];
  const store = new SessionStore(path.join(os.tmpdir(), `lia-admin-pix-bound-${Date.now()}.json`));
  const ana = store.get(CLIENT_PHONE);
  ana.clientName = 'Ana';
  ana.human = true;
  ana.pendingClientPayment = { args: {}, choice: 'pix', createdAt: new Date().toISOString() };
  ana.pendingAdminDecision = pendingDecision(5, '11111111-1111-4111-8111-111111111111');

  const brunaPhone = '5588999992222';
  const bruna = store.get(brunaPhone);
  bruna.clientName = 'Bruna';
  bruna.human = true;
  bruna.pendingClientPayment = { args: {}, choice: 'pix', createdAt: new Date().toISOString() };
  bruna.pendingAdminDecision = pendingDecision(10, '22222222-2222-4222-8222-222222222222');

  const flow = createFlow({
    store,
    getBotConfig: createBotConfig,
    whatsapp: {
      sendText: async (phone, text) => { sentTexts.push({ phone, text }); },
      sendImage: async (phone, image) => { sentImages.push({ phone, image }); }
    },
    ai: { askAI: async () => ({ reply: 'Não deveria precisar consultar a IA.', tool_calls: [] }) },
    logger: { log() {}, warn() {}, error() {} }
  });

  const reply = await flow.process({
    phone: OWNER_SELF_KEY,
    text: 'GERAR PIX 22222222-2222-4222-8222-222222222222',
    origin: 'telegram'
  });

  assert.match(reply, /gerei e enviei o Pix copia e cola/i);
  assert.equal(sentTexts.length, 1);
  assert.equal(sentTexts[0].phone, brunaPhone);
  assert.match(sentTexts[0].text, /R\$ 10,00/);
  assert.equal(bruna.pendingAdminDecision.status, 'completed');
  assert.equal(ana.pendingAdminDecision.status, 'pending');
  assert.equal(sentImages.length, 1);
  assert.equal(sentImages[0].phone, brunaPhone);
});

test('Copiloto: GERAR PIX sem decisão pendente falha fechado e não consulta a IA', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `lia-admin-pix-no-pending-${Date.now()}.json`));
  let aiCalls = 0;
  const sentTexts = [];
  const flow = createFlow({
    store,
    getBotConfig: createBotConfig,
    whatsapp: { sendText: async (phone, text) => sentTexts.push({ phone, text }) },
    ai: { askAI: async () => { aiCalls += 1; return { reply: 'Não deveria gerar nada.', tool_calls: [] }; } },
    logger: { log() {}, warn() {}, error() {} }
  });

  const reply = await flow.process({
    phone: OWNER_SELF_KEY,
    text: 'GERAR PIX',
    origin: 'owner'
  });

  assert.match(reply, /não há uma cobrança Pix aguardando/i);
  assert.equal(aiCalls, 0);
  assert.equal(sentTexts.length, 0);
});

test('Copiloto: resultado incerto pode ser assumido pelo administrador sem reenviar Pix', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `lia-admin-pix-uncertain-${Date.now()}.json`));
  const customer = store.get(CLIENT_PHONE);
  customer.clientName = 'Ana';
  customer.human = true;
  customer.humanSource = 'admin';
  customer.pendingClientPayment = { args: {}, choice: 'pix', createdAt: new Date().toISOString() };
  customer.pendingAdminDecision = {
    ...pendingDecision(5),
    status: 'uncertain',
    error: 'O provedor não confirmou a entrega.'
  };
  const sentTexts = [];
  const sentImages = [];
  const flow = createFlow({
    store,
    getBotConfig: createBotConfig,
    whatsapp: {
      sendText: async (phone, text) => sentTexts.push({ phone, text }),
      sendImage: async (phone, image) => sentImages.push({ phone, image })
    },
    ai: { askAI: async () => ({ reply: 'Não deveria precisar consultar a IA.', tool_calls: [] }) },
    logger: { log() {}, warn() {}, error() {} }
  });

  const reply = await flow.process({
    phone: OWNER_SELF_KEY,
    text: 'ASSUMIR ATENDIMENTO',
    origin: 'owner'
  });

  assert.match(reply, /você assumiu o atendimento/i);
  assert.equal(customer.pendingAdminDecision.status, 'assumed');
  assert.equal(customer.human, true);
  assert.equal(sentTexts.length, 0);
  assert.equal(sentImages.length, 0);
});
