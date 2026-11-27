import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyReactivationToInternalChat } from './http/reactivation-notice.mjs';
import { handlePendingReactivationReply } from './flow/reactivation-reply.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';

function makeStore(initialSessions = {}) {
  const map = new Map(Object.entries(initialSessions));
  let dirty = false;
  return {
    get(key) { return map.get(key) || null; },
    markDirty() { dirty = true; },
    isDirty() { return dirty; }
  };
}

/** Mock de askAI: classifica quando o system é o classificador, responde como Lia caso contrário. */
function makeAiMap(classify) {
  return {
    askAI: async (args) => {
      if (String(args.system || '').includes('classifica a intenção')) {
        const parsed = classify(String(args.userText || ''));
        return parsed === null ? { text: 'erro de provedor' } : { text: JSON.stringify(parsed) };
      }
      return { text: 'Oi! Posso continuar te ajudando por aqui?' };
    }
  };
}

const BASE = {
  now: () => Date.now(),
  owner: 'Tauan',
  botConfig: {},
  whatsapp: { sendText: async () => {} }
};

test('IA: frase clara em linguagem natural fora das regexes => intent correto aplicado', async () => {
  const client = { phone: '5511999991000', clientName: 'Marina', human: false, history: [{ role: 'user', text: 'Tem horário para amanhã?' }] };
  const self = { phone: OWNER_SELF_KEY, history: [] };
  const store = makeStore({ [OWNER_SELF_KEY]: self, '5511999991000': client });
  notifyReactivationToInternalChat({ store, session: client, phone: '5511999991000' });

  // Frase que nenhuma regex atual casaria ("resolvo por minha conta" casaria; esta não)
  const ai = makeAiMap(() => ({ intent: 'HUMAN', confidence: 0.9, interpretation: 'admin quer responder pessoalmente' }));
  const reply = await handlePendingReactivationReply({
    ...BASE, store, ai, sSelf: self, cleanCommand: 'Deixa que eu falo com ela por telefone agora'
  });

  assert.match(reply, /modo humano/i);
  assert.equal(client.human, true);
  assert.equal(self.pendingReactivation, null);
});

test('IA: frase ambígua => UNCERTAIN, pergunta no chat e pending preservado', async () => {
  const client = { phone: '5511999991001', clientName: 'Carlos', human: false, history: [{ role: 'model', text: 'Oi Carlos!' }] };
  const self = { phone: OWNER_SELF_KEY, history: [] };
  const store = makeStore({ [OWNER_SELF_KEY]: self, '5511999991001': client });
  notifyReactivationToInternalChat({ store, session: client, phone: '5511999991001' });

  const ai = makeAiMap(() => ({ intent: 'UNCERTAIN', confidence: 0.3, interpretation: 'admin falou de outro assunto' }));
  const reply = await handlePendingReactivationReply({
    ...BASE, store, ai, sSelf: self, cleanCommand: 'quanha bora almoçar'
  });

  assert.match(reply, /Não entendi|Confirma/i);
  assert.notEqual(self.pendingReactivation, null);
  assert.notEqual(self.pendingReactivation.awaitingConfirmation, null);
  assert.ok(!client.human);
  assert.ok(!client.inactivityClosed);
});

test('IA: confiança baixa com intent legível => confirmação; "sim" aplica a ação', async () => {
  const client = { phone: '5511999991002', clientName: 'Ana', human: false, history: [{ role: 'user', text: 'Ainda tem vaga?' }] };
  const self = { phone: OWNER_SELF_KEY, history: [] };
  const store = makeStore({ [OWNER_SELF_KEY]: self, '5511999991002': client });
  notifyReactivationToInternalChat({ store, session: client, phone: '5511999991002' });

  const ai = makeAiMap(() => ({ intent: 'CLOSE', confidence: 0.4, interpretation: 'provável encerramento' }));
  const first = await handlePendingReactivationReply({
    ...BASE, store, ai, sSelf: self, cleanCommand: 'ah deixa quieto'
  });
  assert.match(first, /Confirma|confirma/i);
  assert.notEqual(self.pendingReactivation, null);

  const second = await handlePendingReactivationReply({
    ...BASE, store, ai, sSelf: self, cleanCommand: 'sim'
  });
  assert.match(second, /encerr/i);
  assert.equal(!!client.inactivityClosed, true);
  assert.equal(self.pendingReactivation, null);
});

test('IA indisponível => fallback por regex mantém comportamento atual', async () => {
  const client = { phone: '5511999991003', clientName: 'Bruno', human: false, history: [{ role: 'user', text: 'Quanto custa?' }] };
  const self = { phone: OWNER_SELF_KEY, history: [] };
  const store = makeStore({ [OWNER_SELF_KEY]: self, '5511999991003': client });
  notifyReactivationToInternalChat({ store, session: client, phone: '5511999991003' });

  const sent = [];
  const previews = [];
  const ai = { askAI: async () => { throw new Error('conexão recusada'); } };
  const reply = await handlePendingReactivationReply({
    ...BASE, store, ai, sSelf: self, cleanCommand: 'Pode continuar e responder ele',
    whatsapp: { sendText: async (jid, text) => sent.push({ jid, text }) },
    stageOutboundDispatch: async (prepared, options) => { previews.push({ prepared, options }); return `PREVIEW ${prepared.message} SIM A1B2C3D4`; }
  });

  assert.match(reply, /PREVIEW/);
  assert.equal(sent.length, 0, 'BOT_CONTINUE não envia ao cliente antes da aprovação');
  assert.equal(previews.length, 1);
  assert.equal(previews[0].prepared.phone, '5511999991003');
  assert.equal(previews[0].options.resumeBot, true);
  assert.equal(self.pendingReactivation, null);
});

test('IA indisponível e sem casamento de regex => pergunta de confirmação e pending preservado', async () => {
  const client = { phone: '5511999991004', clientName: 'Rita', human: false, history: [{ role: 'model', text: 'Oi Rita!' }] };
  const self = { phone: OWNER_SELF_KEY, history: [] };
  const store = makeStore({ [OWNER_SELF_KEY]: self, '5511999991004': client });
  notifyReactivationToInternalChat({ store, session: client, phone: '5511999991004' });

  const ai = { askAI: async () => null };
  const reply = await handlePendingReactivationReply({
    ...BASE, store, ai, sSelf: self, cleanCommand: 'hmm, talvez depois'
  });
  assert.match(reply, /Não entendi|encerrar|humano/i);
  assert.notEqual(self.pendingReactivation, null);
  assert.equal(client.human, false);
});

test('confirmação direta aceita sim sem código e não chama a IA classificadora', async () => {
  const client = { phone: '5511999991005', clientName: 'Lia', human: false, history: [{ role: 'user', text: 'Ainda aguardando?' }] };
  const self = { phone: OWNER_SELF_KEY, history: [] };
  const store = makeStore({ [OWNER_SELF_KEY]: self, '5511999991005': client });
  notifyReactivationToInternalChat({ store, session: client, phone: client.phone });
  const sent = [];
  let classifyCalls = 0;
  const ai = { askAI: async args => {
    if (String(args.system || '').includes('classifica a intenção')) classifyCalls += 1;
    return { text: 'Oi! Posso continuar.' };
  } };
  const reply = await handlePendingReactivationReply({
    ...BASE, store, ai, sSelf: self, cleanCommand: 'sim, pode continuar',
    whatsapp: { sendText: async (jid, text) => sent.push({ jid, text }) },
    stageOutboundDispatch: async prepared => `PREVIEW ${prepared.message}`
  });
  assert.match(reply, /PREVIEW/);
  assert.equal(classifyCalls, 0);
  assert.equal(sent.length, 0);
  assert.equal(self.pendingReactivation, null);
});

test('negação direta aceita não sem código e encerra a confirmação pendente', async () => {
  const client = { phone: '5511999991006', clientName: 'Bia', human: false, history: [{ role: 'user', text: 'Oi' }] };
  const self = { phone: OWNER_SELF_KEY, history: [] };
  const store = makeStore({ [OWNER_SELF_KEY]: self, '5511999991006': client });
  notifyReactivationToInternalChat({ store, session: client, phone: client.phone });
  const first = await handlePendingReactivationReply({
    ...BASE, store, ai: { askAI: async () => null }, sSelf: self, cleanCommand: 'talvez'
  });
  assert.match(first, /Não entendi|Confirma/i);
  const second = await handlePendingReactivationReply({
    ...BASE, store, ai: { askAI: async () => null }, sSelf: self, cleanCommand: 'não, vou responder pessoalmente'
  });
  assert.match(second, /Não executei/i);
  assert.equal(self.pendingReactivation, null);
});

test('resposta binária "sim" à pergunta padrão retoma a Lia sem chamar a IA classificadora', async () => {
  const client = { phone: '5511999991006', clientName: 'Rita', human: false, history: [{ role: 'user', text: 'Ainda aguardando?' }] };
  const self = { phone: OWNER_SELF_KEY, history: [] };
  const store = makeStore({ [OWNER_SELF_KEY]: self, '5511999991006': client });
  notifyReactivationToInternalChat({ store, session: client, phone: client.phone });
  let classifyCalls = 0;
  const ai = { askAI: async args => {
    if (String(args.system || '').includes('classifica a intenção')) classifyCalls += 1;
    return { text: 'Oi! Posso continuar.' };
  } };
  const reply = await handlePendingReactivationReply({
    ...BASE, store, ai, sSelf: self, cleanCommand: 'sim',
    stageOutboundDispatch: async prepared => `PREVIEW ${prepared.message}`
  });
  assert.match(reply, /PREVIEW/);
  assert.equal(classifyCalls, 0);
  assert.equal(self.pendingReactivation, null);
});

test('resposta binária "não" à pergunta padrão mantém o modo humano sem chamar a IA classificadora', async () => {
  const client = { phone: '5511999991007', clientName: 'Paulo', human: false, history: [{ role: 'user', text: 'Alguém aí?' }] };
  const self = { phone: OWNER_SELF_KEY, history: [] };
  const store = makeStore({ [OWNER_SELF_KEY]: self, '5511999991007': client });
  notifyReactivationToInternalChat({ store, session: client, phone: client.phone });
  let classifyCalls = 0;
  const ai = { askAI: async args => {
    if (String(args.system || '').includes('classifica a intenção')) classifyCalls += 1;
    return { text: 'ok' };
  } };
  const reply = await handlePendingReactivationReply({ ...BASE, store, ai, sSelf: self, cleanCommand: 'não' });
  assert.match(reply, /modo humano/i);
  assert.equal(client.human, true);
  assert.equal(classifyCalls, 0);
  assert.equal(self.pendingReactivation, null);
});
