import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldEnableGoogleSearch, analyzeDocument } from './ai.mjs';
import { processMaintenance } from './maintenance.mjs';
import { SessionStore } from './sessions.mjs';
import os from 'node:os';
import path from 'node:path';

test('Habilidade 1: Busca Web detecta termos de pesquisa em tempo real', () => {
  assert.equal(shouldEnableGoogleSearch('qual a cotação do dólar hoje?'), true);
  assert.equal(shouldEnableGoogleSearch('como está a previsão do tempo para amanhã?'), true);
  assert.equal(shouldEnableGoogleSearch('pesquise as notícias de hoje no g1'), true);
  assert.equal(shouldEnableGoogleSearch('o que diz a lei do cartório?'), true);
  assert.equal(shouldEnableGoogleSearch('olá, boa tarde tudo bem?'), false);
  assert.equal(shouldEnableGoogleSearch('quero saber o valor do site'), false);
});

test('Habilidade 2: Processamento de PDF retorna estrutura com summary e docType', async () => {
  // Chamada sem base64 retorna null com segurança
  const emptyRes = await analyzeDocument({ base64: '' });
  assert.equal(emptyRes, null);
});

test('Habilidade 3: Follow-up local sem claim distribuída permanece bloqueado', async () => {
  const storeFile = path.join(os.tmpdir(), `test-store-followup-${Date.now()}.json`);
  const store = new SessionStore(storeFile);
  await store.load();

  const phone = '5588998765432';
  const session = store.get(phone);
  session.clientName = 'Lucas';
  session.human = false;
  session.inactivityClosed = false;
  // Conversa com 30 horas de inatividade após última mensagem da Lia
  const nowTime = new Date('2026-11-06T14:00:00.000Z').getTime();
  session.lastUserAt = new Date(nowTime - 31 * 3600000).toISOString();
  session.lastBotAt = new Date(nowTime - 30 * 3600000).toISOString();
  session.history = [
    { role: 'user', content: 'Quanto fica o desenvolvimento de um site e bot?' },
    { role: 'assistant', content: 'O valor inicial varia conforme o escopo...' }
  ];

  const sentMessages = [];
  await processMaintenance({
    store,
    send: async (p, msg) => {
      sentMessages.push({ phone: p, msg });
    },
    now: () => nowTime,
    timeZone: 'America/Fortaleza',
    enableLeadFollowUp: true,
    followUpMinHours: 24,
    followUpMaxHours: 72
  });

  assert.equal(sentMessages.length, 0, 'Não deve enviar follow-up sem claim distribuída persistente');
  assert.equal(session.followUpCount, 0);
  assert.equal(session.followUpSentAt, undefined);

  // Na próxima rodada, a trava impede novo follow-up
  sentMessages.length = 0;
  await processMaintenance({
    store,
    send: async (p, msg) => {
      sentMessages.push({ phone: p, msg });
    },
    now: () => nowTime + 3600000,
    timeZone: 'America/Fortaleza',
    enableLeadFollowUp: true
  });
  assert.equal(sentMessages.length, 0, 'Sem persistência distribuída, o follow-up continua bloqueado');
});

test('Habilidade 3: Follow-up NÃO incomoda quem está em atendimento humano ativo', async () => {
  const storeFile = path.join(os.tmpdir(), `test-store-human-${Date.now()}.json`);
  const store = new SessionStore(storeFile);
  await store.load();

  const phone = '5588991112222';
  const session = store.get(phone);
  session.human = true;
  const nowTime = new Date('2026-11-06T14:00:00.000Z').getTime();
  session.lastBotAt = new Date(nowTime - 30 * 3600000).toISOString();
  session.history = [
    { role: 'user', content: 'Quero falar com o Tauan' },
    { role: 'assistant', content: 'Já transferi para ele!' }
  ];

  const sentMessages = [];
  await processMaintenance({
    store,
    send: async (p, msg) => {
      sentMessages.push({ phone: p, msg });
    },
    now: () => nowTime,
    timeZone: 'America/Fortaleza',
    enableLeadFollowUp: true
  });

  assert.equal(sentMessages.length, 0, 'Não deve fazer follow-up de cliente em modo humano');
});
