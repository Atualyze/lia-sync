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
      enabled: { gerar_cobranca_pix: true },
      settings: {
        gerar_cobranca_pix: {
          key: 'pix-test@atualyze.com.br',
          merchantName: 'Atualyze',
          merchantCity: 'Sobral'
        }
      }
    }
  };
}

function pendingDecision(amount = 5) {
  return {
    type: 'pix_generation',
    status: 'pending',
    amount,
    description: 'Pagamento via Pix',
    paymentMethod: 'pix_copy_paste',
    requestedAt: new Date().toISOString()
  };
}

test('cliente: valor Pix bloqueado cria decisão administrativa e não gera cobrança', async () => {
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
          : { reply: 'Vou gerar o Pix de R$ 5,00 agora.', tool_calls: [] };
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
  assert.equal(customer.human, true);
  assert.ok(ownerNotice);
  assert.match(ownerNotice.text, /DECISÃO NECESSÁRIA/i);
  assert.match(ownerNotice.text, /GERAR PIX/);
  assert.match(ownerNotice.text, /ASSUMIR ATENDIMENTO/);
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
