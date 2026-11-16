import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidRealMobilePhone, isOwnerContact } from './sessions.mjs';
import { processMaintenance } from './maintenance.mjs';

test('Validação de Telefone: Rejeita estritamente números fictícios e inventados', () => {
  assert.equal(isValidRealMobilePhone('5588999998888'), false, 'Deve rejeitar 999998888');
  assert.equal(isValidRealMobilePhone('5588977112233'), false, 'Deve rejeitar 977112233');
  assert.equal(isValidRealMobilePhone('5588999990000'), false, 'Deve rejeitar 999990000');
  assert.equal(isValidRealMobilePhone('236425802952777@lid'), false, 'Deve rejeitar @lid');
  assert.equal(isValidRealMobilePhone('sim:5588992162295'), false, 'Deve rejeitar simulação');
  assert.equal(isValidRealMobilePhone('owner_self'), false, 'Deve rejeitar chat interno');

  // Celulares reais válidos devem passar
  assert.equal(isValidRealMobilePhone('5588992162295'), true, 'Deve aceitar celular real do Ceará');
  assert.equal(isValidRealMobilePhone('5511984123456'), true, 'Deve aceitar celular real de SP');
});

test('Chat Interno: isOwnerContact reconhece o responsável e variações com/sem nono dígito', () => {
  const ownerPhone = '5588992023309';
  assert.equal(isOwnerContact('owner_self', ownerPhone), true);
  assert.equal(isOwnerContact('5588992023309', ownerPhone), true);
  assert.equal(isOwnerContact('558892023309', ownerPhone), true); // sem nono dígito
  assert.equal(isOwnerContact('5588992023309@s.whatsapp.net', ownerPhone), true);

  // Cliente real não deve ser confundido com o responsável
  assert.equal(isOwnerContact('5588992162295', ownerPhone), false);
});

test('Maintenance: JAMAIS dispara follow-up para número fictício (9999-8888) nem para o responsável', async () => {
  const sentMessages = [];
  const store = {
    sessions: {
      '5588999998888': {
        phone: '5588999998888',
        lastBotAt: new Date(Date.now() - 30 * 3600000).toISOString(),
        history: [{ role: 'user', content: 'Oi' }, { role: 'assistant', content: 'Olá' }],
        human: false
      },
      'owner_self': {
        phone: 'owner_self',
        lastBotAt: new Date(Date.now() - 30 * 3600000).toISOString(),
        history: [{ role: 'user', content: 'status' }, { role: 'assistant', content: 'Operacional' }],
        human: false
      },
      '5588992023309': {
        phone: '5588992023309',
        lastBotAt: new Date(Date.now() - 30 * 3600000).toISOString(),
        history: [{ role: 'user', content: 'Oi Lia' }, { role: 'assistant', content: 'Oi Tauan' }],
        human: false
      }
    },
    markDirty: () => {}
  };

  await processMaintenance({
    store,
    send: async (phone, msg) => {
      sentMessages.push({ phone, msg });
    },
    notify: async () => {},
    humanPhone: '5588992023309',
    enableLeadFollowUp: true,
    followUpMinHours: 24,
    followUpMaxHours: 72
  });

  assert.equal(sentMessages.length, 0, 'Nenhuma mensagem de follow-up pode ser enviada para números fictícios ou para o chat interno!');
});
