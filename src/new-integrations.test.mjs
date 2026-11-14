import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPixPayload, normalizePixKey, toolGerarCobrancaPix } from './tools/gerar_cobranca_pix.mjs';
import { toolConsultarDadosBrasil } from './tools/consultar_dados_brasil.mjs';
import { toolConsultarPlanilhaGoogle } from './tools/consultar_planilha_google.mjs';
import { toolGerenciarDriveGoogle } from './tools/gerenciar_drive_google.mjs';
import { ALL_TOOLS, executeToolCall, isClientToolAllowed } from './tools/index.mjs';
import { extractPdfTextWithPoppler } from './ai/documents.mjs';
import { createFlow } from './flow.mjs';
import { SessionStore } from './sessions.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';

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

  const res = await flow.process({
    phone: '5585999991111',
    text: 'Quero pagar 50 reais no Pix da consulta',
    origin: 'client',
    pushName: 'Maria'
  });
  assert.match(res, /Aqui está seu Pix para pagamento/i);
  assert.match(res, /R\$ 50,00/);
  assert.match(res, /000201/);
  assert.equal(sentImages.length, 1);
  assert.equal(sentImages[0].phone, '5585999991111');
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
