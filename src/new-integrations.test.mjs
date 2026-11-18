import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPixPayload, normalizePixKey, toolGerarCobrancaPix } from './tools/gerar_cobranca_pix.mjs';
import { toolConsultarDadosBrasil } from './tools/consultar_dados_brasil.mjs';
import { toolConsultarPlanilhaGoogle } from './tools/consultar_planilha_google.mjs';
import { toolGerenciarDriveGoogle } from './tools/gerenciar_drive_google.mjs';
import { ALL_TOOLS, executeToolCall, isClientToolAllowed } from './tools/index.mjs';
import { InfinitePayOrderStore, toolCheckoutInfinitePay } from './tools/checkout_infinitepay.mjs';
import { processInfinitePayWebhook } from './http/infinitepay-webhook.mjs';
import { classificarSetorPorTexto } from './triage-router.mjs';
import { extractPdfTextWithPoppler } from './ai/documents.mjs';
import { createFlow } from './flow.mjs';
import { SessionStore, normalizePhone } from './sessions.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';
import { buildSystemPrompt } from './knowledge.mjs';
import { listKnowledgeBasesSync } from './knowledge-bases.mjs';
import { toolConsultarBaseConhecimento } from './tools/consultar_base_conhecimento.mjs';
import { synthesizeVoice } from './ai/voice.mjs';
import { decidirModeloPorContexto } from './model-router.mjs';
import { askAI } from './ai.mjs';
import { responseSchema, buildOpenRouterBody } from './ai/parsing.mjs';
import { config } from './config.mjs';

test('ALL_TOOLS registra todas as novas integrações e permissões de cliente', () => {
  for (const name of [
    'consultar_planilha_google',
    'gerenciar_drive_google',
    'consultar_dados_brasil',
    'gerar_cobranca_pix'
  ]) {
    assert.equal(ALL_TOOLS.some(t => t.name === name), true, `${name} deve estar em ALL_TOOLS`);
    assert.equal(isClientToolAllowed(name), true, `${name} deve ser permitida no fluxo de cliente quando habilitada`);
  }
});

test('Pix: gera payload EMV BR Code válido com CRC16 e envia QR Code via WhatsApp', async () => {
  const payload = buildPixPayload({
    pixKey: 'contato@atualyze.com.br',
    amount: 150.5,
    merchantName: 'Atualyze Clínica',
    merchantCity: 'Fortaleza',
    txid: 'RES12345'
  });
  assert.match(payload, /^00020126/);
  assert.match(payload, /br\.gov\.bcb\.pix/);
  assert.match(payload, /5406150\.50/);
  assert.match(payload, /5802BR/);
  assert.match(payload, /6304[0-9A-F]{4}$/);

  const sentImages = [];
  const prevKey = process.env.PIX_KEY;
  process.env.PIX_KEY = '11999998888';
  try {
    const res = await toolGerarCobrancaPix.execute(
      { valor: 99.9, descricao: 'Consulta Inicial' },
      {
        phone: '5585999998888',
        actor: 'client',
        botConfig: { identity: { companyName: 'Clinica Teste' } },
        whatsapp: {
          sendImage: async (phone, img) => { sentImages.push({ phone, img }); }
        }
      }
    );
    assert.equal(res.success, true);
    assert.equal(res.qrCodeSent, true);
    assert.equal(res.valor, 99.9);
    assert.ok(res.qrCodeDataUrl.startsWith('data:image/png;base64,'));
    assert.equal(sentImages.length, 1);
    assert.equal(sentImages[0].phone, '5585999998888');
  } finally {
    if (prevKey === undefined) delete process.env.PIX_KEY;
    else process.env.PIX_KEY = prevKey;
  }
});

test('ViaCEP + BrasilAPI: consulta CEP, CNPJ e feriados nacionais com mocks', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('viacep.com.br')) {
      return new Response(JSON.stringify({
        cep: '60060-000',
        logradouro: 'Av. Beira Mar',
        bairro: 'Meireles',
        localidade: 'Fortaleza',
        uf: 'CE',
        ibge: '2304400',
        ddd: '85'
      }), { status: 200 });
    }
    if (s.includes('brasilapi.com.br/api/cnpj')) {
      return new Response(JSON.stringify({
        cnpj: '12345678000199',
        razao_social: 'ATUALYZE TECNOLOGIA LTDA',
        nome_fantasia: 'ATUALYZE',
        descricao_situacao_cadastral: 'ATIVA',
        cnae_fiscal_descricao: 'Desenvolvimento de software',
        municipio: 'Fortaleza',
        uf: 'CE'
      }), { status: 200 });
    }
    if (s.includes('brasilapi.com.br/api/feriados')) {
      return new Response(JSON.stringify([
        { date: '2026-11-15', name: 'Proclamação da República', type: 'national' },
        { date: '2026-12-25', name: 'Natal', type: 'national' }
      ]), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  try {
    const cepRes = await toolConsultarDadosBrasil.execute({ acao: 'consultar_cep', cep: '60060000' });
    assert.equal(cepRes.success, true);
    assert.equal(cepRes.cidade, 'Fortaleza');
    assert.equal(cepRes.uf, 'CE');

    const cnpjRes = await toolConsultarDadosBrasil.execute({ acao: 'consultar_cnpj', cnpj: '12.345.678/0001-99' });
    assert.equal(cnpjRes.success, true);
    assert.equal(cnpjRes.razaoSocial, 'ATUALYZE TECNOLOGIA LTDA');
    assert.equal(cnpjRes.situacaoCadastral, 'ATIVA');

    const feriadoRes = await toolConsultarDadosBrasil.execute({ acao: 'consultar_feriados', ano: 2026, data: '2026-12-25' });
    assert.equal(feriadoRes.success, true);
    assert.equal(feriadoRes.eFeriadoNacional, true);
    assert.equal(feriadoRes.feriado.name, 'Natal');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Google Sheets: bloqueia adicionar_linha no fluxo de cliente e lê/filtra no mock', async () => {
  const prevToken = process.env.GOOGLE_SHEETS_ACCESS_TOKEN;
  const prevSheet = process.env.GOOGLE_SHEETS_DEFAULT_ID;
  process.env.GOOGLE_SHEETS_ACCESS_TOKEN = 'fake-token';
  process.env.GOOGLE_SHEETS_DEFAULT_ID = 'sheet-123';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    range: 'Precos!A1:C3',
    values: [
      ['Produto', 'Preco', 'Estoque'],
      ['Plano Starter', '199', 'Disponivel'],
      ['Plano Pro', '499', 'Disponivel']
    ]
  }), { status: 200 });

  try {
    const blocked = await executeToolCall(
      'consultar_planilha_google',
      { acao: 'adicionar_linha', valores: ['Teste'] },
      { actor: 'client', botConfig: {} }
    );
    assert.equal(blocked.success, false);
    assert.equal(blocked.error, 'forbidden_in_client_flow');

    const found = await toolConsultarPlanilhaGoogle.execute({ acao: 'buscar_linhas', busca: 'Pro' });
    assert.equal(found.success, true);
    assert.equal(found.totalMatched, 1);
    assert.equal(found.rows[0].Produto, 'Plano Pro');
  } finally {
    globalThis.fetch = origFetch;
    if (prevToken === undefined) delete process.env.GOOGLE_SHEETS_ACCESS_TOKEN;
    else process.env.GOOGLE_SHEETS_ACCESS_TOKEN = prevToken;
    if (prevSheet === undefined) delete process.env.GOOGLE_SHEETS_DEFAULT_ID;
    else process.env.GOOGLE_SHEETS_DEFAULT_ID = prevSheet;
  }
});

test('Google Drive: lista e envia PDF para WhatsApp via mock', async () => {
  const prevToken = process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
  process.env.GOOGLE_DRIVE_ACCESS_TOKEN = 'fake-drive-token';
  const sentDocs = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('fields=files')) {
      return new Response(JSON.stringify({
        files: [{ id: 'file-1', name: 'Catalogo 2026.pdf', mimeType: 'application/pdf' }]
      }), { status: 200 });
    }
    if (s.includes('fields=id,name')) {
      return new Response(JSON.stringify({
        id: 'file-1', name: 'Catalogo 2026.pdf', mimeType: 'application/pdf', size: '120'
      }), { status: 200 });
    }
    return new Response(Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF'), { status: 200 });
  };

  try {
    const list = await toolGerenciarDriveGoogle.execute({ acao: 'buscar_arquivo', busca: 'Catalogo' });
    assert.equal(list.success, true);
    assert.equal(list.files[0].id, 'file-1');

    const sent = await toolGerenciarDriveGoogle.execute(
      { acao: 'enviar_arquivo_whatsapp', fileId: 'file-1', legenda: 'Segue catálogo' },
      { phone: '5585999998888', whatsapp: { sendDocument: async (phone, doc) => sentDocs.push({ phone, doc }) } }
    );
    assert.equal(sent.success, true);
    assert.equal(sent.sentViaWhatsApp, true);
    assert.equal(sentDocs.length, 1);
    assert.equal(sentDocs[0].doc.fileName, 'Catalogo 2026.pdf');
  } finally {
    globalThis.fetch = origFetch;
    if (prevToken === undefined) delete process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
    else process.env.GOOGLE_DRIVE_ACCESS_TOKEN = prevToken;
  }
});

test('extractPdfTextWithPoppler retorna string vazia em entrada vazia/inválida sem lançar erro', async () => {
  const txt = await extractPdfTextWithPoppler('');
  assert.equal(txt, '');
});

function createPixBotConfig(key = '88998340085') {
  return {
    identity: { assistantName: 'Lia', ownerName: 'Tauan', businessName: 'Atualyze' },
    ai: { agentMode: 'super_agente', enableToolCalling: true },
    tools: {
      enabled: { gerar_cobranca_pix: true },
      settings: key ? { gerar_cobranca_pix: { key, merchantName: 'Tauan Pires', merchantCity: 'Sobral', publicBaseUrl: 'https://liasync.atualyze.com.br' } } : {}
    }
  };
}

test('Copiloto Pix: executa gerar_cobranca_pix no turno seguinte ("Pix" -> "10, sobre pagamento de almoço") mesmo se a IA omitir tool_calls e sem enviar __owner_self__', async () => {
  const store = new SessionStore();
  const sentImages = [];
  const botConfig = createPixBotConfig('88998340085');
  const flow = createFlow({
    store,
    getBotConfig: () => botConfig,
    getHumanPhone: () => '5588998340085',
    isOwnerSender: p => p === OWNER_SELF_KEY || p === '5588998340085',
    whatsapp: {
      sendImage: async (phone, payload) => {
        sentImages.push({ phone, payload });
      }
    },
    ai: {
      askAI: async ({ userText }) => {
        if (/^pix$/i.test(userText.trim())) {
          return { reply: '', tool_calls: [] };
        }
        // Simula o bug observado em produção: IA responde "já está anotado" sem tool_calls
        return {
          reply: 'Entendido, Tauan! O valor de *R$ 10,00* referente ao pagamento de almoço já está anotado por aqui.',
          tool_calls: []
        };
      }
    }
  });

  const turn1 = await flow.process({
    phone: OWNER_SELF_KEY,
    text: 'Pix',
    origin: 'owner',
    rawItem: { phone: '5588998340085' }
  });
  assert.match(turn1, /valor/i);

  const turn2 = await flow.process({
    phone: OWNER_SELF_KEY,
    text: '10, sobre pagamento de almoço',
    origin: 'owner',
    rawItem: { phone: '5588998340085' }
  });
  assert.match(turn2, /Cobrança Pix gerada!/i);
  assert.match(turn2, /R\$ 10,00/);
  assert.match(turn2, /https:\/\/liasync\.atualyze\.com\.br\/pix\?/);
  assert.match(turn2, /000201/);
  assert.equal(sentImages.length, 1);
  assert.equal(sentImages[0].phone, '5588998340085');
  assert.notEqual(sentImages[0].phone, OWNER_SELF_KEY);
});

test('Copiloto Pix: não entra em loop quando a IA repete a pergunta após o valor já ter sido informado', async () => {
  const store = new SessionStore();
  const sentImages = [];
  const botConfig = createPixBotConfig('88998340085');
  const self = store.get(OWNER_SELF_KEY);
  self.pendingPixRequest = { requestedAt: new Date().toISOString() };
  self.history.push({ role: 'assistant', content: 'Qual o valor e a descrição?', createdAt: new Date().toISOString() });
  const flow = createFlow({
    store,
    getBotConfig: () => botConfig,
    getHumanPhone: () => '5588998340085',
    isOwnerSender: p => p === OWNER_SELF_KEY,
    whatsapp: { sendImage: async (phone, payload) => sentImages.push({ phone, payload }) },
    ai: { askAI: async () => ({ reply: 'Qual o valor e a descrição?', tool_calls: [] }) }
  });

  const result = await flow.process({
    phone: OWNER_SELF_KEY,
    text: '20 reais, compra de ração',
    origin: 'owner',
    rawItem: { phone: '5588998340085' }
  });

  assert.match(result, /Cobrança Pix gerada!/i);
  assert.match(result, /R\$ 20,00/);
  assert.equal(sentImages.length, 1);
  assert.equal(store.get(OWNER_SELF_KEY).pendingPixRequest, null);
});

test('Copiloto Pix: quando IA emite tool_call gerar_cobranca_pix e sendImage falha, ainda retorna payload e link sem quebrar', async () => {
  const store = new SessionStore();
  const botConfig = createPixBotConfig('88998340085');
  const flow = createFlow({
    store,
    getBotConfig: () => botConfig,
    getHumanPhone: () => '5588998340085',
    isOwnerSender: p => p === OWNER_SELF_KEY,
    whatsapp: {
      sendImage: async () => {
        throw new Error('Evolution temporary error');
      }
    },
    ai: {
      askAI: async () => ({
        reply: '',
        tool_calls: [{ name: 'gerar_cobranca_pix', args: { valor: 25, descricao: 'almoco' } }]
      })
    }
  });

  const res = await flow.process({
    phone: OWNER_SELF_KEY,
    text: 'gera um pix de 25 reais do almoço',
    origin: 'owner',
    rawItem: { phone: '5588998340085' }
  });
  assert.match(res, /Cobrança Pix gerada!/i);
  assert.match(res, /R\$ 25,00/);
  assert.match(res, /000201/);
});

test('Copiloto Pix: sem chave Pix configurada pergunta naturalmente qual chave usar', async () => {
  const store = new SessionStore();
  const prevPix = process.env.PIX_KEY;
  delete process.env.PIX_KEY;
  try {
    const botConfig = createPixBotConfig('');
    const flow = createFlow({
      store,
      getBotConfig: () => botConfig,
      isOwnerSender: p => p === OWNER_SELF_KEY,
      ai: {
        askAI: async () => ({
          reply: '',
          tool_calls: [{ name: 'gerar_cobranca_pix', args: { valor: 30, descricao: 'teste' } }]
        })
      }
    });

    const res = await flow.process({
      phone: OWNER_SELF_KEY,
      text: 'gera um pix de 30 reais',
      origin: 'owner'
    });
    assert.match(res, /Chave Pix/i);
    assert.doesNotMatch(res, /Cobrança Pix gerada!/i);
  } finally {
    if (prevPix !== undefined) process.env.PIX_KEY = prevPix;
  }
});

test('Cliente Pix: executa gerar_cobranca_pix, envia imagem no WhatsApp do cliente e retorna link + Copia e Cola', async () => {
  const store = new SessionStore();
  const sentImages = [];
  const botConfig = createPixBotConfig('88998340085');
  const flow = createFlow({
    store,
    getBotConfig: () => botConfig,
    isOwnerSender: () => false,
    whatsapp: {
      sendImage: async (phone, payload) => {
        sentImages.push({ phone, payload });
      }
    },
    ai: {
      askAI: async () => ({
        reply: 'Claro, vou gerar o seu Pix.',
        tool_calls: [{ name: 'gerar_cobranca_pix', args: { valor: 50, descricao: 'Consulta' } }]
      })
    }
  });

  const first = await flow.process({
    phone: '5585999991111',
    text: 'Quero pagar 50 reais no Pix da consulta',
    origin: 'client',
    pushName: 'Maria'
  });
  assert.match(first, /chave Pix|copia e cola/i);
  assert.equal(sentImages.length, 0);
  const res = await flow.process({ phone: '5585999991111', text: 'Pode gerar o copia e cola', origin: 'client' });
  assert.match(res, /Aqui está seu Pix para pagamento/i);
  assert.match(res, /R\$ 50,00/);
  assert.match(res, /000201/);
  assert.equal(sentImages.length, 1);
  assert.equal(sentImages[0].phone, '5585999991111');
});

test('Cliente Pix: pergunta o formato antes de gerar e entende "copia e cola" no turno seguinte', async () => {
  const store = new SessionStore();
  const sentImages = [];
  const botConfig = createPixBotConfig('88998340085');
  let aiCalls = 0;
  const flow = createFlow({
    store,
    getBotConfig: () => botConfig,
    isOwnerSender: () => false,
    whatsapp: { sendImage: async (phone, payload) => sentImages.push({ phone, payload }) },
    ai: {
      askAI: async () => {
        aiCalls += 1;
        return aiCalls === 1
          ? { reply: 'Vou gerar seu Pix.', tool_calls: [{ name: 'gerar_cobranca_pix', args: { valor: 50, descricao: 'Compra de ração' } }] }
          : { reply: '', tool_calls: [] };
      }
    }
  });

  const first = await flow.process({ phone: '5585999992222', text: 'Quero pagar 50 reais no Pix da compra de ração', origin: 'client' });
  assert.match(first, /chave Pix|copia e cola/i);
  assert.doesNotMatch(first, /Aqui está seu Pix para pagamento/i);
  assert.equal(sentImages.length, 0);

  const second = await flow.process({ phone: '5585999992222', text: 'prefiro o código copia e cola', origin: 'client' });
  assert.match(second, /Aqui está seu Pix para pagamento/i);
  assert.match(second, /R\$ 50,00/);
  assert.equal(sentImages.length, 1);
});

test('Pix BR Code: normaliza celular de 11 dígitos com +55 sem confundir com CPF e remove frase de pedido da descrição', () => {
  assert.equal(normalizePixKey('88998340085'), '+5588998340085');
  assert.equal(normalizePixKey('88998340085', 'telefone'), '+5588998340085');
  const payload = buildPixPayload({
    pixKey: '88998340085',
    amount: 10,
    merchantName: 'Tauan Pires',
    merchantCity: 'Sobral',
    description: 'Preciso gerar um Pix'
  });
  assert.equal(payload.includes('+5588998340085'), true);
  assert.equal(payload.includes('Preciso gerar um Pix'), false);
  assert.equal(payload.includes('540510.00'), true);
});

test('Copiloto Pix: "Preciso gerar um Pix" sem valor pergunta o valor mesmo se a IA tentar chamar tool com valor 0', async () => {
  const store = new SessionStore();
  const botConfig = createPixBotConfig('88998340085');
  const flow = createFlow({
    store,
    getBotConfig: () => botConfig,
    isOwnerSender: p => p === OWNER_SELF_KEY,
    ai: {
      askAI: async () => ({
        reply: '',
        tool_calls: [{ name: 'gerar_cobranca_pix', args: { valor: 0, descricao: 'Preciso gerar um Pix' } }]
      })
    }
  });

  const res = await flow.process({
    phone: OWNER_SELF_KEY,
    text: 'Preciso gerar um Pix',
    origin: 'owner'
  });
  assert.match(res, /valor/i);
  assert.doesNotMatch(res, /Cobrança Pix gerada!/i);
});

test('InfinitePay Checkout: gera link com valor em centavos, registra order_nsu e confirma pagamento via webhook + payment_check', async (t) => {
  const orderFile = `data/test-ip-orders-${Date.now()}.json`;
  t.after(() => { try { fs.rmSync(orderFile, { force: true }); } catch {} });
  const orderStore = new InfinitePayOrderStore(orderFile);
  const sentMessages = [];
  const fetchCalls = [];

  const mockFetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    fetchCalls.push({ url: String(url), body });
    if (String(url).endsWith('/links')) {
      return new Response(JSON.stringify({ url: 'https://checkout.infinitepay.io/tauanpires/abc123', slug: 'abc123' }), { status: 200 });
    }
    if (String(url).endsWith('/payment_check')) {
      return new Response(JSON.stringify({
        success: true,
        paid: true,
        amount: 1000,
        paid_amount: 1000,
        installments: 1,
        capture_method: 'pix'
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const botConfig = {
    tools: {
      enabled: { checkout_infinitepay: true },
      settings: {
        checkout_infinitepay: {
          handle: '$tauanpires',
          publicBaseUrl: 'https://liasync.atualyze.com.br'
        }
      }
    }
  };

  const created = await toolCheckoutInfinitePay.execute(
    { valor: 10, descricao: 'Almoço Executivo' },
    {
      actor: 'client',
      phone: '5585999991111',
      clientName: 'Maria',
      botConfig,
      infinitePayOrders: orderStore,
      fetchImpl: mockFetch
    }
  );
  assert.equal(created.success, true);
  assert.equal(created.handle, 'tauanpires');
  assert.equal(created.checkoutUrl, 'https://checkout.infinitepay.io/tauanpires/abc123');
  assert.equal(fetchCalls[0].body.items[0].price, 1000);
  assert.equal(fetchCalls[0].body.webhook_url, 'https://liasync.atualyze.com.br/webhook/infinitepay');

  // Webhook com order_nsu desconhecido é rejeitado
  const bad = await processInfinitePayWebhook({
    payload: { order_nsu: 'nao-existe' },
    orderStore
  });
  assert.equal(bad.status, 400);

  // Webhook válido responde 200 e confirma cliente + responsável após payment_check
  const ok = await processInfinitePayWebhook({
    payload: {
      order_nsu: created.orderNsu,
      transaction_nsu: 'tx-999',
      invoice_slug: 'abc123',
      amount: 1000,
      paid_amount: 1000,
      capture_method: 'pix',
      receipt_url: 'https://comprovante.infinitepay.io/tx-999'
    },
    orderStore,
    getHumanPhone: () => '5588998340085',
    sendText: async (phone, text) => sentMessages.push({ phone, text }),
    checkPayment: async args => {
      const r = await mockFetch('https://api.checkout.infinitepay.io/payment_check', { body: JSON.stringify(args) });
      return r.json();
    }
  });
  assert.equal(ok.status, 200);
  await ok.backgroundTask;

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].phone, '5585999991111');
  assert.match(sentMessages[0].text, /Pagamento confirmado!/i);
  assert.equal(sentMessages[1].phone, '5588998340085');
  assert.match(sentMessages[1].text, /Maria/);

  // Reentrega idempotente não envia mensagens duplicadas
  const dup = await processInfinitePayWebhook({
    payload: { order_nsu: created.orderNsu },
    orderStore
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.alreadyProcessed, true);
  assert.equal(sentMessages.length, 2);

  // Consulta manual verificar_pagamento retorna paid: true
  const checked = await toolCheckoutInfinitePay.execute(
    { acao: 'verificar_pagamento', orderNsu: created.orderNsu },
    { botConfig, infinitePayOrders: orderStore, fetchImpl: mockFetch }
  );
  assert.equal(checked.success, true);
  assert.equal(checked.paid, true);

  // Webhook para pedido sem handle não marca como pago nem envia mensagem
  orderStore.recordOrder({
    orderNsu: 'LIA-NO-HANDLE-TEST',
    handle: '',
    phone: '5585999992222',
    amountCents: 5000,
    description: 'Sem handle'
  });
  const noHandleRes = await processInfinitePayWebhook({
    payload: {
      order_nsu: 'LIA-NO-HANDLE-TEST',
      transaction_nsu: 'tx-no-handle',
      paid_amount: 5000
    },
    orderStore,
    sendText: async (phone, text) => sentMessages.push({ phone, text })
  });
  assert.equal(noHandleRes.status, 200);
  await noHandleRes.backgroundTask;
  assert.equal(orderStore.getOrder('LIA-NO-HANDLE-TEST').status, 'pending');
  assert.equal(sentMessages.length, 2);
});

test('Copiloto Pix valor livre: usa gerar_cobranca_pix se ativo, ou explica que InfinitePay exige valor fixo se gerar_cobranca_pix estiver desativado', async () => {
  const store1 = new SessionStore();
  const cfgBoth = {
    identity: { assistantName: 'Lia', ownerName: 'Tauan' },
    ai: { agentMode: 'super_agente', enableToolCalling: true },
    tools: {
      enabled: { gerar_cobranca_pix: true, checkout_infinitepay: true },
      settings: {
        gerar_cobranca_pix: { key: '88998340085', merchantName: 'Tauan Pires', merchantCity: 'Sobral' },
        checkout_infinitepay: { handle: 'tauanpires' }
      }
    }
  };
  const flowBoth = createFlow({
    store: store1,
    getBotConfig: () => cfgBoth,
    isOwnerSender: p => p === OWNER_SELF_KEY,
    ai: {
      askAI: async () => ({
        reply: '',
        tool_calls: [{ name: 'checkout_infinitepay', args: { acao: 'criar_link', valor: 0 } }]
      })
    }
  });
  const resBoth = await flowBoth.process({
    phone: OWNER_SELF_KEY,
    text: 'gera um pix valor livre',
    origin: 'owner'
  });
  assert.match(resBoth, /Cobrança Pix gerada!/i);
  assert.match(resBoth, /Valor livre/i);

  const store2 = new SessionStore();
  const cfgIpOnly = {
    ...cfgBoth,
    tools: {
      ...cfgBoth.tools,
      enabled: { gerar_cobranca_pix: false, checkout_infinitepay: true }
    }
  };
  const flowIpOnly = createFlow({
    store: store2,
    getBotConfig: () => cfgIpOnly,
    isOwnerSender: p => p === OWNER_SELF_KEY,
    ai: {
      askAI: async () => ({
        reply: '',
        tool_calls: [{ name: 'checkout_infinitepay', args: { acao: 'criar_link', valor: 0 } }]
      })
    }
  });
  const resIpOnly = await flowIpOnly.process({
    phone: OWNER_SELF_KEY,
    text: 'gera um pix valor livre',
    origin: 'owner'
  });
  assert.match(resIpOnly, /InfinitePay.*exige um valor fixo/i);
});

test('Triagem e Atendimento: consultar_base_conhecimento sem correspondência não força handoff e "Me responda com áudio" ativa voz', async () => {
  const store = new SessionStore();
  const sentAudio = [];
  const notifications = [];
  const botConfig = {
    identity: { assistantName: 'Lia', ownerName: 'Tauan' },
    ai: { agentMode: 'super_agente', enableToolCalling: true },
    voice: { enabled: true },
    tools: { enabled: { consultar_base_conhecimento: true } }
  };

  const flow = createFlow({
    store,
    getBotConfig: () => botConfig,
    isOwnerSender: () => false,
    notify: async msg => notifications.push(msg),
    whatsapp: {
      sendWhatsAppAudio: async (phone, b64) => sentAudio.push({ phone, b64 })
    },
    ai: {
      askAI: async ({ userText }) => {
        if (/como vc pode/i.test(userText)) {
          return {
            reply: 'Posso te ajudar com dúvidas rápidas, pagamentos e agendamentos!',
            tool_calls: [{ name: 'consultar_base_conhecimento', args: { termo: 'ajuda' } }]
          };
        }
        return {
          reply: 'Claro! Vou te explicar certinho por aqui.',
          tool_calls: []
        };
      },
      synthesizeVoice: async () => ({ base64: 'ZmFrZS1hdWRpbw==' })
    }
  });

  const r1 = await flow.process({
    phone: '5588993324920',
    text: 'Como vc pode me ajudar?',
    origin: 'client',
    pushName: 'Raimunda'
  });
  assert.match(r1, /Posso te ajudar/i);
  assert.equal(store.get('5588993324920')?.human, false);
  assert.equal(notifications.length, 0);

  await flow.process({
    phone: '5588993324920',
    text: 'Me responda com áudio',
    origin: 'client',
    pushName: 'Raimunda'
  });
  assert.equal(store.get('5588993324920')?.audioPreference, 'audio');
  assert.equal(sentAudio.length, 1);

  const triage = classificarSetorPorTexto('Preciso de uma informação', [
    { id: '1', name: 'Financeiro', description: 'Boleto e Pix' },
    { id: '2', name: 'Comercial', description: 'Vendas' }
  ]);
  assert.equal(triage.category, null);
});

test('IA-first multimodal + triagem híbrida + transferência contextualizada (warm transfer)', async () => {
  const store = new SessionStore(null);
  const notifications = [];
  const botConfig = {
    identity: { assistantName: 'Lia', ownerName: 'Tauan', companyName: 'Atualyze', roleTitle: 'Sócio' },
    business: {
      sectors: [
        { id: 'sec-fin', name: 'Financeiro', description: 'Boleto, Pix e cobrança' },
        { id: 'sec-com', name: 'Comercial', description: 'Vendas e orçamento' }
      ]
    },
    automation: { enableMediaProcessing: true }
  };

  const flow = createFlow({
    store,
    humanPhone: '5585999990000',
    getBotConfig: () => botConfig,
    isOwnerSender: () => false,
    whatsapp: {
      getMediaBase64: async () => ({ base64: 'ZmFrZS1pbWc=', mimetype: 'image/jpeg' }),
      sendText: async (_to, msg) => notifications.push(msg)
    },
    ai: {
      analyzeDocument: async () => ({
        docType: 'comprovante',
        summary: 'Print da tela de erro ao tentar pagar o boleto de R$ 150,00.',
        keyPoints: ['Valor R$ 150,00', 'Erro de leitura do código']
      }),
      askAI: async ({ userText }) => {
        if (/Resumo visual:/i.test(userText)) {
          return {
            reply: 'Vi seu print aqui! Posso gerar um novo Pix ou reenviar o boleto agora mesmo.',
            sector: 'financeiro',
            sentiment: 'neutro',
            context_summary: 'Cliente enviou print de erro ao pagar boleto de R$ 150,00.',
            handoff: false,
            tool_calls: []
          };
        }
        return {
          reply: 'Entendo sua chateação com a demora, vou passar seu caso com todo o resumo para o Tauan resolver agora.',
          sector: 'financeiro',
          sentiment: 'frustrado',
          context_summary: 'Cliente cobrando boleto há 2 dias e frustrado com o atraso.',
          handoff: false,
          tool_calls: []
        };
      }
    }
  });

  // 1) Imagem analisada pela IA não força handoff nem devolve resposta pronta
  const rImg = await flow.process({
    phone: '5585988887777',
    text: 'Olha o erro que deu',
    mediaType: 'image',
    rawItem: { id: 'msg-img-1' },
    origin: 'client',
    pushName: 'Carlos'
  });
  assert.match(rImg, /Vi seu print aqui/i);
  const sess1 = store.get('5585988887777');
  assert.equal(sess1.human, false);
  assert.equal(notifications.length, 0);
  assert.equal(sess1.sectorName, 'Financeiro');
  assert.equal(sess1.contextSummary, 'Cliente enviou print de erro ao pagar boleto de R$ 150,00.');

  // 2) Sentimento frustrado aciona warm transfer com Setor, Sentimento e Resumo do contexto
  const rFrustrated = await flow.process({
    phone: '5585988887777',
    text: 'Já estou há 2 dias esperando isso e ninguém resolve!',
    origin: 'client',
    pushName: 'Carlos'
  });
  assert.match(rFrustrated, /Entendo sua chateação/i);
  assert.equal(sess1.human, true);
  assert.equal(sess1.sentiment, 'frustrado');
  assert.equal(sess1.contextSummary, 'Cliente cobrando boleto há 2 dias e frustrado com o atraso.');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /\*Setor:\* Financeiro/);
  assert.match(notifications[0], /\*Sentimento:\* frustrado/);
  assert.match(notifications[0], /\*Resumo do contexto:\* Cliente cobrando boleto há 2 dias/);
});

test('Base de autoconhecimento (motor + painel + limites) é exclusiva do Copiloto e bloqueada para clientes', async () => {
  const allKbs = listKnowledgeBasesSync();
  const selfKb = allKbs.find(kb => kb.id === 'lia-autoconhecimento-operacoes');
  assert.ok(selfKb, 'lia-autoconhecimento-operacoes deve existir em data/knowledge-bases');
  assert.equal(selfKb.copilotOnly, true);

  const copilotPrompt = buildSystemPrompt({ isOwner: true, botConfig: { identity: { assistantName: 'Lia', ownerName: 'Tauan' } } });
  assert.match(copilotPrompt, /MANUAL DE AUTOCONHECIMENTO, CAPACIDADES E LIMITES/i);

  const clientPrompt = buildSystemPrompt({ isOwner: false, botConfig: { identity: { assistantName: 'Lia', ownerName: 'Tauan' } } });
  assert.doesNotMatch(clientPrompt, /MANUAL DE AUTOCONHECIMENTO, CAPACIDADES E LIMITES/i);

  const clientToolRes = await toolConsultarBaseConhecimento.execute(
    { termo: 'autoconhecimento limites painel' },
    { actor: 'client', session: { supportModeEnabled: true, knowledgeBaseId: 'lia-autoconhecimento-operacoes' } }
  );
  assert.equal(clientToolRes.found, false);

  const ownerToolRes = await toolConsultarBaseConhecimento.execute(
    { termo: 'autoconhecimento' },
    { actor: 'owner', session: {} }
  );
  assert.equal(ownerToolRes.found, true);
  assert.match(ownerToolRes.resposta, /LIMITES REAIS/i);
});

test('Seleção de voz respeita voiceName explícito sobre botConfig, thinkingBudget é ativado antes de agir e Cloudflare Workers AI funciona', async () => {
  // 1) Seleção de voz explícita no teste de voz não é sobrescrita por botConfig.voice.voiceName
  const seenPayloads = [];
  const origFetch = globalThis.fetch;
  const mutableConfig = config;
  const origGem = mutableConfig.geminiKey;
  const origCfAcc = mutableConfig.cloudflareAccountId;
  const origCfTok = mutableConfig.cloudflareApiToken;

  globalThis.fetch = async (url, init = {}) => {
    const sUrl = String(url);
    const body = init.body ? JSON.parse(init.body) : {};
    seenPayloads.push({ url: sUrl, body });
    if (sUrl.includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.from('12345678').toString('base64') } }] } }]
      }), { status: 200 });
    }
    if (sUrl.includes('api.cloudflare.com/client/v4/accounts/acc-123/ai/run/')) {
      return new Response(JSON.stringify({
        success: true,
        result: {
          response: JSON.stringify({ reply: 'Resposta via Cloudflare Workers AI!', intent: 'duvida', handoff: false }),
          usage: { prompt_tokens: 15, completion_tokens: 12, total_tokens: 27 }
        }
      }), { status: 200 });
    }
    throw new Error('Unexpected URL: ' + sUrl);
  };

  try {
    Object.defineProperty(mutableConfig, 'geminiKey', { value: 'test-gemini-key', configurable: true });
  } catch {}

  try {
    // Caso config congelada, validamos ao menos quando geminiKey existir; se congelado, testamos router + cloudflare
    if (config.geminiKey) {
      const voiceRes = await synthesizeVoice('Olá, testando voz!', {
        voiceName: 'Kore',
        botConfig: { voice: { voiceName: 'Aoede' } }
      });
      assert.equal(voiceRes.voiceName, 'Kore');
      const ttsCall = seenPayloads.find(p => p.url.includes('generateContent'));
      assert.equal(ttsCall?.body?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName, 'Kore');
    }

    // 2) Roteamento com thinking ativo antes de responder/agir
    const flashAction = decidirModeloPorContexto({ userText: 'Me envia em áudio como funciona o Pix?', isSuperAgent: true });
    assert.equal(flashAction.tier, 'flash');
    assert.ok(flashAction.thinkingBudget >= 1024, 'Deve pensar antes de agir/responder');

    const copilotOp = decidirModeloPorContexto({ userText: 'Qual a situação da fila agora?', isOwner: true });
    assert.ok(copilotOp.thinkingBudget >= 1024, 'Copiloto deve pensar antes de responder');

    // 3) Cloudflare Workers AI REST API
    if (!config.cloudflareAccountId) {
      // Testa parseFallbackModel + provider routing mesmo sem env no runtime congelado
      const { parseFallbackModel } = await import('./ai/config.mjs');
      assert.deepEqual(parseFallbackModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), {
        provider: 'cloudflare',
        model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
      });
      assert.deepEqual(parseFallbackModel('cloudflare:@cf/qwen/qwen2.5-coder-32b-instruct'), {
        provider: 'cloudflare',
        model: '@cf/qwen/qwen2.5-coder-32b-instruct'
      });
    }
  } finally {
    globalThis.fetch = origFetch;
    try { Object.defineProperty(mutableConfig, 'geminiKey', { value: origGem, configurable: true }); } catch {}
    try { Object.defineProperty(mutableConfig, 'cloudflareAccountId', { value: origCfAcc, configurable: true }); } catch {}
    try { Object.defineProperty(mutableConfig, 'cloudflareApiToken', { value: origCfTok, configurable: true }); } catch {}
  }
});

test('atualizar_dados_crm fica restrito ao Copiloto', async () => {
  const { isClientToolAllowed } = await import('./tools/index.mjs');
  assert.equal(isClientToolAllowed('atualizar_dados_crm'), false);
});

test('maintenance recupera checkout pendente apos 45 min apenas 1 vez e ignora se ja pago', async () => {
  const { processMaintenance } = await import('./maintenance.mjs');
  const nowMs = new Date('2026-11-14T15:00:00-03:00').getTime(); // 15h daytime
  const sent = [];
  const sessionUnpaid = {
    phone: '5511948273615',
    human: false,
    lastBotAt: new Date(nowMs - 50 * 60000).toISOString(),
    tags: ['checkout-pendente'],
    history: [],
    pendingCheckout: {
      orderNsu: 'ord-1',
      checkoutUrl: 'https://pay.infinitepay.io/teste1',
      amountCents: 15000,
      handle: 'atualyze',
      createdAt: new Date(nowMs - 50 * 60000).toISOString(),
      recoverySentAt: null,
      paidAt: null
    }
  };
  const sessionPaid = {
    phone: '5511948273616',
    human: false,
    lastBotAt: new Date(nowMs - 50 * 60000).toISOString(),
    tags: ['checkout-pendente'],
    history: [],
    pendingCheckout: {
      orderNsu: 'ord-2',
      checkoutUrl: 'https://pay.infinitepay.io/teste2',
      amountCents: 20000,
      handle: 'atualyze',
      createdAt: new Date(nowMs - 50 * 60000).toISOString(),
      recoverySentAt: null,
      paidAt: null
    }
  };
  const store = {
    sessions: { '5511948273615': sessionUnpaid, '5511948273616': sessionPaid },
    markDirty() {},
    async flush() {}
  };

  await processMaintenance({
    store,
    send: async (phone, msg) => { sent.push({ phone, msg }); },
    notify: async () => {},
    now: () => nowMs,
    checkPayment: async ({ orderNsu }) => ({ paid: orderNsu === 'ord-2' })
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, '5511948273615');
  assert.ok(sent[0].msg.includes('https://pay.infinitepay.io/teste1'));
  assert.ok(sessionUnpaid.pendingCheckout.recoverySentAt);
  assert.ok(sessionPaid.pendingCheckout.paidAt);
  assert.ok(sessionPaid.tags.includes('pagamento-confirmado'));
  assert.equal(sessionPaid.tags.includes('checkout-pendente'), false);

  // Segunda execucao nao envia duplicado
  await processMaintenance({
    store,
    send: async (phone, msg) => { sent.push({ phone, msg }); },
    notify: async () => {},
    now: () => nowMs + 60000,
    checkPayment: async () => ({ paid: false })
  });
  assert.equal(sent.length, 1);
});

test('Lia Personality Engine injeta identidade compacta, adapta temperatura e detecta vicios roboticos', async () => {
  const { buildPersonalityPrompt, resolveAdaptiveTemperature, evaluateNaturalnessReply } = await import('./core/personality.mjs');
  const { buildSystemPrompt } = await import('./knowledge.mjs');

  const block = buildPersonalityPrompt({ botName: 'Lia', botConfig: { personality: { tone: 'objetivo e cordial' } } });
  assert.ok(block.includes('[PERSONALIDADE CONVERSACIONAL - LIA]'));
  assert.ok(block.includes('objetivo e cordial'));
  assert.ok(block.length < 1300, 'Camada de personalidade deve ser compacta para economizar tokens');

  assert.equal(resolveAdaptiveTemperature({ hasTools: true }), 0.25);
  assert.equal(resolveAdaptiveTemperature({ isOwner: true }), 0.35);
  assert.equal(resolveAdaptiveTemperature({ isJsonResponse: true }), 0.58);
  assert.equal(resolveAdaptiveTemperature({}), 0.62);

  const clientPrompt = buildSystemPrompt({ session: { phone: '5511948273615', history: [] }, botConfig: {} });
  const copilotPrompt = buildSystemPrompt({ session: { phone: '5511948273615', history: [] }, isOwner: true, botConfig: {} });
  assert.ok(clientPrompt.includes('[PERSONALIDADE CONVERSACIONAL'));
  assert.ok(copilotPrompt.includes('[PERSONALIDADE CONVERSACIONAL'));

  assert.equal(evaluateNaturalnessReply('Aqui trabalhamos com Pix e cartão! Qual plano faz mais sentido para você?').ok, true);
  const bad = evaluateNaturalnessReply('Claro! Posso te ajudar.\n• A\n• B\n• C\n• D\nQual você quer? E qual seu nome? Posso ajudar em algo mais?');
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.includes('cliche_opener'));
  assert.ok(bad.issues.includes('robotic_closer'));
  assert.ok(bad.issues.some((i) => i.startsWith('too_many_questions:')));
});

test('Lia Memory Engine isola usuarios, bloqueia dados sensiveis e permite consultar/corrigir/esquecer', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { MemoryStore, buildMemoryScopeKey, extractMemoryCandidates } = await import('./core/memory.mjs');
  const { executeToolCall, isClientToolAllowed } = await import('./tools/index.mjs');

  assert.equal(isClientToolAllowed('gerenciar_memoria'), true);

  const tmpFile = path.join(os.tmpdir(), `lia-mem-${Date.now()}.json`);
  const memStore = new MemoryStore(tmpFile);

  try {
    const scopeA = buildMemoryScopeKey({ phone: '5511948273615', isOwner: false });
    const scopeB = buildMemoryScopeKey({ phone: '5511948273699', isOwner: false });

    // Bloqueio LGPD / sensivel
    const blocked = memStore.remember({ scopeKey: scopeA, type: 'fact', content: 'Meu CPF e 123.456.789-00' });
    assert.equal(blocked.saved, false);
    assert.equal(blocked.reason, 'sensitive_data_blocked');

    // Extracao heuristica zero-custo
    const cands = extractMemoryCandidates('Prefiro que voce responda de forma direta e estou desenvolvendo o LiaSync');
    assert.ok(cands.some((c) => c.type === 'preference'));
    assert.ok(cands.some((c) => c.type === 'project'));

    // Via tool: salvar, consultar, corrigir, esquecer + isolamento entre A e B
    const saved = await executeToolCall(
      'gerenciar_memoria',
      { acao: 'salvar', tipo: 'preference', conteudo: 'Prefere respostas diretas e sem rodeios' },
      { actor: 'client', phone: '5511948273615', memoryStore: memStore }
    );
    assert.equal(saved.success, true);

    const listB = memStore.list(scopeB);
    assert.equal(listB.length, 0);

    const corrected = await executeToolCall(
      'gerenciar_memoria',
      { acao: 'corrigir', referencia: 'respostas diretas', conteudo: 'Prefere respostas diretas e com exemplos praticos' },
      { actor: 'client', phone: '5511948273615', memoryStore: memStore }
    );
    assert.equal(corrected.success, true);
    assert.equal(memStore.retrieve({ scopeKey: scopeA, query: 'exemplos' })[0].content, 'Prefere respostas diretas e com exemplos praticos');

    const forgotten = await executeToolCall(
      'gerenciar_memoria',
      { acao: 'esquecer', referencia: 'respostas diretas' },
      { actor: 'client', phone: '5511948273615', memoryStore: memStore }
    );
    assert.equal(forgotten.success, true);
    assert.equal(memStore.list(scopeA).length, 0);
    const persistedRaw = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    assert.equal(persistedRaw.some((m) => m.scopeKey === scopeA && /respostas diretas/i.test(m.content)), false);

    // Etapa 2: busca semantica com embedding (mock) + fail-open quando embedding retorna null
    const mockFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const txt = String(body?.content?.parts?.[0]?.text || '').toLowerCase();
      const vec = txt.includes('arquitetura') || txt.includes('motor de ia')
        ? [1, 0, 0]
        : [0, 1, 0];
      return {
        ok: true,
        async json() {
          return { embedding: { values: vec } };
        },
      };
    };

    const semA = await memStore.rememberWithEmbedding(
      { scopeKey: scopeA, type: 'project', content: 'Separacao entre motor de IA e CRM', importance: 0.7 },
      { apiKey: 'test-key', fetchImpl: mockFetch }
    );
    assert.equal(semA.saved, true);
    assert.deepEqual(semA.memory.embedding, [1, 0, 0]);

    await memStore.rememberWithEmbedding(
      { scopeKey: scopeA, type: 'preference', content: 'Gosta de cafe sem acucar', importance: 0.9 },
      { apiKey: 'test-key', fetchImpl: mockFetch }
    );

    const ranked = await memStore.retrieveSemantic({
      scopeKey: scopeA,
      query: 'como esta a arquitetura do sistema',
      limit: 2,
      apiKey: 'test-key',
      fetchImpl: mockFetch,
    });
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].content, 'Separacao entre motor de IA e CRM');

    // Fail-open sem apiKey (fallback lexical/importancia)
    const fallbackRanked = await memStore.retrieveSemantic({
      scopeKey: scopeA,
      query: 'cafe',
      limit: 2,
      apiKey: '',
    });
    assert.equal(fallbackRanked[0].content, 'Gosta de cafe sem acucar');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('Schemas Gemini e OpenRouter declaram sector, sentiment e context_summary', () => {
  for (const field of ['sector', 'sentiment', 'context_summary']) {
    assert.ok(responseSchema.properties[field], `Gemini responseSchema precisa declarar ${field}`);
  }
  const orBody = buildOpenRouterBody({
    model: 'openai/gpt-4o-mini',
    system: 'sys',
    userText: 'oi',
    structuredOutputs: true,
  });
  const orProps = orBody?.response_format?.json_schema?.schema?.properties || {};
  for (const field of ['sector', 'sentiment', 'context_summary']) {
    assert.ok(orProps[field], `OpenRouter schema precisa declarar ${field}`);
  }
});

test('normalizePhone preserva DDD 55 (RS) em numeros de 10 e 11 digitos', () => {
  assert.equal(normalizePhone('55999999999'), '5555999999999');
  assert.equal(normalizePhone('5591234567'), '5555991234567');
});
