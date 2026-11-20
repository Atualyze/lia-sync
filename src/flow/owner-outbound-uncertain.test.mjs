import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlow } from '../flow.mjs';

function createMockStore() {
  const sessions = {};
  return {
    sessions,
    get(phone, origin = 'real') {
      const key = origin === 'simulation' ? `sim:${phone}` : phone;
      if (!sessions[key]) {
        sessions[key] = {
          phone,
          history: [],
          human: false,
          handoffAt: null,
          origin
        };
      }
      return sessions[key];
    },
    touch() {},
    markDirty() {},
    async claimOutboundDispatch() {
      throw new Error('não deveria tentar reservar envio neste teste');
    }
  };
}

test('Copiloto mantém conversa normal com despacho incerto e só bloqueia nova confirmação de envio', async () => {
  const ownerPhone = '5588921694598';
  const store = createMockStore();
  const self = store.get(ownerPhone);
  self.pendingOutboundDispatch = {
    id: 'DISP1234',
    phone: '5585991099483',
    recipient: 'Lima',
    message: 'Oi, Lima! A proposta ficou pronta.',
    source: 'copilot',
    status: 'uncertain',
    createdAt: new Date().toISOString()
  };

  const sent = [];
  const flow = createFlow({
    store,
    humanPhone: ownerPhone,
    getHumanPhone: () => ownerPhone,
    whatsapp: {
      sendText: async (phone, text) => { sent.push({ phone, text }); }
    },
    ai: {
      askAI: async ({ userText, system }) => {
        if (system?.includes('Você interpreta a intenção do responsável sobre um disparo WhatsApp que já existe.')
          && /marque como concluído/i.test(userText || '')) {
          return { reply: '{"intent":"resolve","confidence":0.96,"reason":"pedido explícito para encerrar a pendência"}' };
        }
        return {
          intent: 'chat',
          reply: userText?.toLowerCase() === 'bom dia'
            ? 'Bom dia! Estou aqui. Como posso ajudar?'
            : 'Oi! Estou aqui e pronta para ajudar.',
          tool_calls: []
        };
      }
    }
  });

  const greeting = await flow.process({ phone: ownerPhone, text: 'Oi' });
  assert.match(greeting, /Oi|olá/i);
  assert.doesNotMatch(greeting, /disparo já está em processamento|resultado incerto/i);
  assert.equal(self.pendingOutboundDispatch.status, 'uncertain');

  const morning = await flow.process({ phone: ownerPhone, text: 'Bom dia' });
  assert.match(morning, /Bom dia/i);
  assert.doesNotMatch(morning, /disparo já está em processamento|resultado incerto/i);
  assert.equal(self.pendingOutboundDispatch.status, 'uncertain');

  const explanation = await flow.process({ phone: ownerPhone, text: 'Que disparo?' });
  assert.match(explanation, /Lima/);
  assert.match(explanation, /resultado incerto/i);
  assert.match(explanation, /proposta ficou pronta/i);
  assert.match(explanation, /não iniciou um disparo/i);
  assert.equal(self.pendingOutboundDispatch.status, 'uncertain');

  const repeatedApproval = await flow.process({ phone: ownerPhone, text: 'sim' });
  assert.match(repeatedApproval, /resultado incerto/i);
  assert.equal(self.pendingOutboundDispatch.status, 'uncertain');
  assert.equal(sent.length, 0, 'nenhuma mensagem pode ser reenviada automaticamente');

  const resolved = await flow.process({ phone: ownerPhone, text: 'Ok, marque como concluído' });
  assert.match(resolved, /revisado\/encerrado administrativamente/i);
  assert.match(resolved, /não marquei como entregue ou concluído/i);
  assert.equal(self.pendingOutboundDispatch.status, 'uncertain');
  assert.ok(self.pendingOutboundDispatch.reviewedBy);
  assert.equal(sent.length, 0, 'resolver administrativamente não pode reenviar a mensagem');
});

test('modelo conversacional recebe contexto operacional da pendência ao interpretar referência curta', async () => {
  const ownerPhone = '5588921694598';
  const store = createMockStore();
  const self = store.get(ownerPhone);
  self.pendingOutboundDispatch = {
    id: 'DISP5678',
    phone: '5585991099483',
    recipient: 'ptbr',
    message: 'Mensagem preparada para ptbr',
    source: 'copilot',
    status: 'uncertain',
    createdAt: new Date().toISOString()
  };
  let conversationalSystem = '';
  const flow = createFlow({
    store,
    humanPhone: ownerPhone,
    getHumanPhone: () => ownerPhone,
    whatsapp: { sendText: async () => { throw new Error('não deveria enviar'); } },
    ai: {
      askAI: async ({ system = '' }) => {
        if (system.includes('Você interpreta a intenção do responsável sobre um disparo WhatsApp que já existe.')) {
          return { reply: '{"intent":"none","confidence":0.99,"reason":"referência sem decisão"}' };
        }
        conversationalSystem = system;
        return { intent: 'chat', reply: 'O contato ptbr tem um disparo com resultado incerto.', tool_calls: [] };
      }
    }
  });

  const reply = await flow.process({ phone: ownerPhone, text: 'ptbr' });
  assert.match(reply, /ptbr/);
  assert.match(conversationalSystem, /\[CONTEXTO_OPERACIONAL_ATUAL\]/);
  assert.match(conversationalSystem, /"status":"uncertain"/);
  assert.match(conversationalSystem, /"deliveryConfirmed":false/);
  assert.equal(self.pendingOutboundDispatch.status, 'uncertain');
});
