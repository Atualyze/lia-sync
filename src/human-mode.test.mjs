import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from './sessions.mjs';
import { createFlow } from './flow.mjs';

test('Modo humano: Lia não responde mensagens de texto normais', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `test-human-${Date.now()}-${Math.random()}.json`));
  await store.load();
  const session = store.get('5588999990001');
  session.human = true;
  session.handoffAt = new Date().toISOString();

  let aiCalled = false;
  const flow = createFlow({
    store,
    ai: {
      askAI: async () => {
        aiCalled = true;
        return { reply: 'Resposta indevida da IA' };
      }
    },
    faq: async () => []
  });

  const reply = await flow.process({
    phone: '5588999990001',
    text: 'Olá, gostaria de saber se vocês atendem hoje?'
  });

  assert.equal(reply, null, 'Lia não deve responder quando em modo humano');
  assert.equal(aiCalled, false, 'IA não deve ser acionada em modo humano');
  assert.equal(session.human, true, 'Sessão deve continuar em modo humano');
  assert.equal(session.history.at(-1)?.content, 'Olá, gostaria de saber se vocês atendem hoje?');
});

test('Modo humano: Lia não responde quando o cliente envia áudio, foto ou vídeo', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `test-media-${Date.now()}-${Math.random()}.json`));
  await store.load();
  const session = store.get('5588999990002');
  session.human = true;
  session.handoffAt = new Date().toISOString();

  let aiCalled = false;
  const flow = createFlow({
    store,
    ai: {
      askAI: async () => {
        aiCalled = true;
        return { reply: 'IA chamada indevidamente' };
      },
      transcribeAudio: async () => 'Aqui está o áudio do cliente'
    },
    whatsapp: {
      getMediaBase64: async () => ({ base64: 'fake', mimetype: 'audio/ogg' })
    },
    faq: async () => []
  });

  // Teste de áudio em modo humano
  const audioReply = await flow.process({
    phone: '5588999990002',
    mediaType: 'audio'
  });
  assert.equal(audioReply, null, 'Lia não deve responder ao receber áudio em modo humano');
  assert.equal(session.human, true);

  // Teste de imagem em modo humano
  const imageReply = await flow.process({
    phone: '5588999990002',
    mediaType: 'image',
    text: 'Comprovante em anexo'
  });
  assert.equal(imageReply, null, 'Lia não deve responder ao receber imagem em modo humano');
  assert.equal(session.human, true);
  assert.equal(aiCalled, false);
});

test('Modo humano: Lia não se reativa por tempo decorrido (30min ou 2h+)', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `test-stale-${Date.now()}-${Math.random()}.json`));
  await store.load();
  const session = store.get('5588999990003');
  session.human = true;
  // Handoff ocorreu há 4 horas
  session.handoffAt = new Date(Date.now() - 4 * 3600000).toISOString();

  const flow = createFlow({
    store,
    ai: {
      askAI: async () => ({ reply: 'Não deveria responder' })
    },
    faq: async () => []
  });

  const reply = await flow.process({
    phone: '5588999990003',
    text: 'Boa tarde, ainda estou aguardando'
  });

  assert.equal(reply, null, 'Lia não deve responder mesmo após horas');
  assert.equal(session.human, true, 'Sessão deve continuar em modo humano');
});

test('Modo humano: Respeito à política allowClientResume', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `test-resume-${Date.now()}-${Math.random()}.json`));
  await store.load();
  const session = store.get('5588999990004');
  session.human = true;
  session.handoffAt = new Date().toISOString();

  // Quando allowClientResume é false, nem o comando 'bot' retoma
  const flowDisabled = createFlow({
    store,
    allowClientResume: false,
    ai: { askAI: async () => ({ reply: 'Erro' }) },
    faq: async () => []
  });

  const resDisabled = await flowDisabled.process({
    phone: '5588999990004',
    text: 'voltar bot'
  });
  assert.equal(resDisabled, null, 'Não deve reativar quando allowClientResume é false');
  assert.equal(session.human, true);

  // Quando allowClientResume é true e recebe comando explícito, retoma com mensagem amigável
  const flowEnabled = createFlow({
    store,
    allowClientResume: true,
    ai: { askAI: async () => ({ reply: 'IA ativa' }) },
    faq: async () => []
  });

  const resEnabled = await flowEnabled.process({
    phone: '5588999990004',
    text: 'voltar bot'
  });
  assert.match(resEnabled, /Atendimento automático retomado/i);
  assert.equal(session.human, false, 'Modo humano deve ter sido desativado');
});
