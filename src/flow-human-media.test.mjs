import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createFlow } from './flow.mjs';
import { SessionStore } from './sessions.mjs';

test('mídia recebida durante handoff humano não é baixada nem enviada à IA', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `lia-human-media-${Date.now()}.json`));
  await store.load();
  const phone = '5511999990010';
  const session = store.get(phone);
  session.human = true;

  let mediaDownloads = 0;
  let transcriptionCalls = 0;
  let visionCalls = 0;
  let aiCalls = 0;
  const flow = createFlow({
    store,
    getBotConfig: () => ({ identity: { botName: 'Lia', responsible: 'Equipe' } }),
    faq: async () => [],
    whatsapp: {
      async getMediaBase64() { mediaDownloads += 1; return { base64: 'ZmFrZQ==' }; }
    },
    ai: {
      async transcribeAudio() { transcriptionCalls += 1; return 'voltar bot'; },
      async analyzeDocument() { visionCalls += 1; return { summary: 'conteúdo' }; },
      async askAI() { aiCalls += 1; return { reply: 'não deveria chamar' }; }
    }
  });

  const media = [
    { mediaType: 'audio', text: '', messageId: 'audio-1' },
    { mediaType: 'image', text: '', messageId: 'image-1' },
    { mediaType: 'document', text: '', messageId: 'document-1' }
  ];

  for (const item of media) {
    const reply = await flow.process({
      phone,
      text: item.text,
      mediaType: item.mediaType,
      nonText: true,
      rawItem: { jid: phone, message: {} },
      messageId: item.messageId
    });
    assert.equal(reply, null);
  }

  assert.equal(mediaDownloads, 0);
  assert.equal(transcriptionCalls, 0);
  assert.equal(visionCalls, 0);
  assert.equal(aiCalls, 0);
  assert.deepEqual(
    session.history.map(message => message.content),
    [
      '[Áudio recebido durante atendimento humano]',
      '[Imagem recebida durante atendimento humano]',
      '[Documento recebido durante atendimento humano]'
    ]
  );
  assert.equal(session.human, true);
});

test('mensagem de texto explícita ainda pode retomar o bot durante handoff', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `lia-human-resume-${Date.now()}.json`));
  await store.load();
  const phone = '5511999990011';
  const session = store.get(phone);
  session.human = true;
  session.humanSource = 'handoff';

  const flow = createFlow({
    store,
    allowClientResume: true,
    getBotConfig: () => ({ identity: { botName: 'Lia', responsible: 'Equipe' } }),
    faq: async () => [],
    ai: { async askAI() { throw new Error('IA não deve ser chamada para comando de retomada'); } }
  });

  const reply = await flow.process({ phone, text: 'voltar bot' });

  assert.match(reply, /atendimento automático retomado/i);
  assert.equal(session.human, false);
  assert.equal(session.humanSource, 'resume');
});
