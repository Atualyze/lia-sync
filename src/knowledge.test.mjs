import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, isEmergency, isAffirmative, isGreeting, findFaqInItems, findFaq, buildSystemPrompt } from './knowledge.mjs';

test('helpers de texto reconhecem saudacoes, afirmacoes e emergencias', () => {
  assert.equal(normalize('  Olá, Tudo Bem? '), 'ola tudo bem');
  assert.equal(isGreeting('oi'), true);
  assert.equal(isAffirmative('sim'), true);
  assert.equal(isEmergency('socorro emergencia'), true);
  assert.equal(isEmergency('bom dia'), false);
});

test('findFaqInItems e findFaq buscam respostas e buildSystemPrompt gera prompt', () => {
  const items = [{ keys: ['preco', 'valor'], answer: 'Consulte a tabela.' }];
  assert.equal(findFaqInItems('qual o preco?', items), 'Consulte a tabela.');
  assert.ok(findFaq('horario') === null || typeof findFaq('horario') === 'string');
  const prompt = buildSystemPrompt({ session: { phone: '5511999998888', history: [] } });
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length > 20);
  assert.doesNotMatch(prompt, /resposta natural pronta para WhatsApp/i);
  assert.match(prompt, /PROTOCOLO DE DELIBERAÇÃO/);
  const ownerPrompt = buildSystemPrompt({ session: { history: [] }, isOwner: true });
  assert.match(ownerPrompt, /PROTOCOLO DE DELIBERAÇÃO/);
  assert.doesNotMatch(ownerPrompt, /sua resposta bem formatada com quebras de linha duplas/i);
  assert.doesNotMatch(ownerPrompt, /\[CONTINUIDADE_ENTRE_MODELOS_E_TURNOS\]/);

  const activeOwnerPrompt = buildSystemPrompt({
    session: {
      history: [
        { role: 'user', content: 'Quero cobrar 25 reais' },
        { role: 'assistant', content: 'Qual a descrição da cobrança?' }
      ],
      contextSummary: 'Cobrança Pix de R$ 25 aguardando descrição'
    },
    isOwner: true
  });
  assert.match(activeOwnerPrompt, /\[CONTINUIDADE_ENTRE_MODELOS_E_TURNOS\]/);
  assert.match(activeOwnerPrompt, /Cobrança Pix de R\$ 25 aguardando descrição/);
  assert.match(activeOwnerPrompt, /Qual a descrição da cobrança\?/);

  const activeClientPrompt = buildSystemPrompt({
    session: {
      phone: '5511999998888',
      history: [
        { role: 'user', content: 'Oi, quero saber sobre os planos' },
        { role: 'assistant', content: 'Temos os planos Start e Pro. Qual prefere?' },
        { role: 'user', content: 'E no cartão tem desconto?' }
      ],
      contextSummary: 'Cliente avaliando planos Start e Pro'
    },
    isOwner: false
  });
  assert.match(activeClientPrompt, /\[CONTINUIDADE_ENTRE_MODELOS_E_TURNOS\]/);
  assert.match(activeClientPrompt, /Cliente avaliando planos Start e Pro/);
  assert.match(activeClientPrompt, /Temos os planos Start e Pro\. Qual prefere\?/);
});
