import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { createFlow } from '../flow.mjs';
import { ADMIN_CONSULT_TTL_MS, listPendingAdminConsults } from './admin-consult.mjs';
import { SessionStore } from '../sessions.mjs';
import { getEnabledTools } from '../tools/index.mjs';
import { toolGerenciarDriveGoogle } from '../tools/gerenciar_drive_google.mjs';
import { buildSystemPrompt } from '../knowledge.mjs';
import { OWNER_SELF_KEY } from '../core/identity.mjs';
import { config } from '../config.mjs';
import { memoryStore } from '../core/memory.mjs';

test('sem credenciais Google, ferramentas Drive/Sheets/Agenda não são expostas ao LLM e o prompt proíbe mentir', () => {
  const prevKeys = {
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    GOOGLE_SERVICE_ACCOUNT_KEY: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    GOOGLE_DRIVE_ACCESS_TOKEN: process.env.GOOGLE_DRIVE_ACCESS_TOKEN,
    GOOGLE_SHEETS_ACCESS_TOKEN: process.env.GOOGLE_SHEETS_ACCESS_TOKEN,
    GOOGLE_CALENDAR_ACCESS_TOKEN: process.env.GOOGLE_CALENDAR_ACCESS_TOKEN,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN
  };
  for (const k of Object.keys(prevKeys)) delete process.env[k];

  try {
    const enabledClientTools = getEnabledTools({}, { actor: 'client' }).map(t => t.name);
    assert.equal(enabledClientTools.includes('gerenciar_drive_google'), false);
    assert.equal(enabledClientTools.includes('consultar_planilha_google'), false);
    assert.equal(enabledClientTools.includes('gerenciar_agenda_google'), false);

    const prompt = buildSystemPrompt({
      session: { phone: '5588999991111', history: [] },
      botConfig: { ai: { agentMode: 'super_agente', enableToolCalling: true } },
      isOwner: false
    });
    assert.doesNotMatch(prompt, /"gerenciar_drive_google"/);
    assert.doesNotMatch(prompt, /"consultar_planilha_google"/);
    assert.match(prompt, /SERVIÇOS GOOGLE NÃO CONECTADOS/);
    assert.match(prompt, /REGRA ANTI-MENTIRA/);
  } finally {
    for (const [k, v] of Object.entries(prevKeys)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
});

test('guarda anti-mentira bloqueia promessa falsa de Drive, consulta o admin no chat interno e retorna ao cliente automaticamente', async () => {
  const file = path.join(os.tmpdir(), `admin-consult-${Date.now()}.json`);
  const store = new SessionStore(file);
  await store.load();
  const sentToClient = [];
  const sentToOwner = [];
  const ownerPhone = '5588921694598';
  const clientPhone = '5588998340085';

  let aiStep = 0;
  const flow = createFlow({
    store,
    faq: async () => [],
    humanPhone: ownerPhone,
    getHumanPhone: () => ownerPhone,
    isOwnerSender: p => p === OWNER_SELF_KEY || p === ownerPhone,
    getBotConfig: () => ({
      identity: { assistantName: 'Lia', ownerName: 'Tauan', businessName: 'Atualyze' },
      ai: { agentMode: 'super_agente', enableToolCalling: true }
    }),
    whatsapp: {
      sendText: async (to, msg) => {
        if (to === ownerPhone) sentToOwner.push(msg);
        else sentToClient.push({ to, msg });
      }
    },
    ai: {
      askAI: async () => {
        aiStep += 1;
        if (aiStep === 1) {
          // Modelo tenta mentir dizendo que vai buscar contrato no Drive
          return {
            reply: 'Tenho sim! Vou buscar o modelo de contrato aqui no nosso drive e te mando pra você dar uma olhada. Só um instante.',
            intent: 'duvida',
            red_flags: false,
            handoff: false,
            tool_calls: []
          };
        }
        // Passo 2: formula resposta natural para o cliente usando a orientação do admin
        return {
          reply: 'Acabei de confirmar por aqui! Nós enviamos a minuta do contrato na reunião de alinhamento, logo após a escolha do plano. Quer que a gente já agende essa conversa?',
          intent: 'atendimento',
          red_flags: false,
          handoff: false
        };
      }
    }
  });

  try {
    // 1. Cliente pede modelo de contrato
    const replyToClient = await flow.process({
      phone: clientPhone,
      text: 'Vc tem o modelo de contrato para que eu possa ver?',
      origin: 'real',
      pushName: 'Atualyze'
    });

    assert.doesNotMatch(replyToClient, /drive|só um instante/i, 'não deve mentir que vai buscar no Drive');
    assert.match(replyToClient, /consultei \*Tauan\*|canal interno/i);
    assert.equal(sentToOwner.length, 1, 'deve chamar o admin no chat interno');
    assert.match(sentToOwner[0], /Consulta da Lia/i);
    assert.match(sentToOwner[0], /modelo de contrato/i);

    const clientSession = store.get(clientPhone);
    assert.equal(clientSession.human, false, 'não deve pausar a Lia em modo humano permanente');
    assert.equal(clientSession.pendingAdminConsult?.status, 'pending');

    // 2. Admin responde no chat interno com a orientação
    const ownerConfirmation = await flow.process({
      phone: OWNER_SELF_KEY,
      text: 'Diz que enviamos a minuta do contrato na reunião de alinhamento após escolher o plano',
      origin: 'owner'
    });

    assert.match(ownerConfirmation, /Retornei para Atualyze e o atendimento continua comigo/i);
    assert.match(ownerConfirmation, /Salvei essa orientação na memória de negócio/i);
    assert.equal(sentToClient.length, 1, 'deve entregar a resposta automaticamente ao cliente');
    assert.match(sentToClient[0].msg, /minuta do contrato na reunião de alinhamento/i);
    assert.equal(clientSession.pendingAdminConsult, null);
    assert.equal(clientSession.human, false);
    assert.match(clientSession.history.at(-1).content, /minuta do contrato/i);

    // 3. Próximo cliente que perguntar sobre modelo de contrato já recebe o aprendizado no prompt
    const nextClientPrompt = buildSystemPrompt({
      session: { phone: '5588999992222', history: [], lastUserText: 'Vocês têm o modelo de contrato?' },
      isOwner: false
    });
    assert.match(nextClientPrompt, /minuta do contrato na reunião de alinhamento/i);
  } finally {
    // Limpa memória de negócio criada no teste
    for (const mem of memoryStore.list('default:business')) {
      if (mem.source === 'admin_consult') memoryStore.forget({ scopeKey: 'default:business', id: mem.id });
    }
    await rm(file, { force: true }).catch(() => {});
  }
});

test('Google Workspace hot-reload ativa Drive/Docs/Sheets/Agenda e ler_documento extrai texto de Google Docs', async () => {
  const prevId = config.googleClientId;
  const prevSecret = config.googleClientSecret;
  const prevRefresh = config.googleRefreshToken;
  const prevToken = process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
  const prevFetch = globalThis.fetch;

  try {
    config.googleClientId = 'test-client-id';
    config.googleClientSecret = 'test-client-secret';
    config.googleRefreshToken = 'test-refresh-token';

    const tools = getEnabledTools({}, { actor: 'client' }).map(t => t.name);
    assert.equal(tools.includes('gerenciar_drive_google'), true);
    assert.equal(tools.includes('consultar_planilha_google'), true);
    assert.equal(tools.includes('gerenciar_agenda_google'), true);

    process.env.GOOGLE_DRIVE_ACCESS_TOKEN = 'ya29.test-token';
    globalThis.fetch = async (url) => {
      const sUrl = String(url);
      if (sUrl.includes('fields=id,name,mimeType,size')) {
        return new Response(JSON.stringify({
          id: 'doc-123',
          name: 'Modelo de Contrato Atualyze',
          mimeType: 'application/vnd.google-apps.document',
          size: '1024'
        }), { status: 200 });
      }
      if (sUrl.includes('/export?mimeType=text/plain')) {
        return new Response('CLÁUSULA 1: Prestação de serviços de automação com IA sem fidelidade.', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const doc = await toolGerenciarDriveGoogle.execute({ acao: 'ler_documento', fileId: 'doc-123' }, {});
    assert.equal(doc.success, true);
    assert.equal(doc.fileName, 'Modelo de Contrato Atualyze');
    assert.match(doc.content, /CLÁUSULA 1/);
  } finally {
    config.googleClientId = prevId;
    config.googleClientSecret = prevSecret;
    config.googleRefreshToken = prevRefresh;
    if (prevToken === undefined) delete process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
    else process.env.GOOGLE_DRIVE_ACCESS_TOKEN = prevToken;
    globalThis.fetch = prevFetch;
  }
});


test('consulta administrativa vencida continua rastreada e visível ao responsável até resolução/cancelamento', () => {
  const requestedAt = Date.now() - ADMIN_CONSULT_TTL_MS - 1000;
  const sessions = {
    '5588999991111': {
      phone: '5588999991111',
      pendingAdminConsult: { id: 'consult-old', status: 'pending', requestedAt, commitmentId: 'commitment-1' }
    }
  };
  const pending = listPendingAdminConsults(sessions, { nowMs: Date.now() });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].consult.commitmentId, 'commitment-1');
  assert.equal(pending[0].overdue, true);
  assert.ok(pending[0].ageMs > ADMIN_CONSULT_TTL_MS);
});
