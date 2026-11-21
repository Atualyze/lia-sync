import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { createFlow } from '../flow.mjs';
import { SessionStore } from '../sessions.mjs';
import { getEnabledTools } from '../tools/index.mjs';
import { buildSystemPrompt } from '../knowledge.mjs';
import { OWNER_SELF_KEY } from '../core/identity.mjs';

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
    assert.equal(sentToClient.length, 1, 'deve entregar a resposta automaticamente ao cliente');
    assert.match(sentToClient[0].msg, /minuta do contrato na reunião de alinhamento/i);
    assert.equal(clientSession.pendingAdminConsult, null);
    assert.equal(clientSession.human, false);
    assert.match(clientSession.history.at(-1).content, /minuta do contrato/i);
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
});
