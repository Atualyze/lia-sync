import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NEUTRAL_IDENTITY,
  OWNER_SELF_KEY,
  OWNER_SELF_ALIASES,
  buildOwnerNamePattern,
  identityNames,
  isOwnerContact,
  isOwnerKey,
  isTalkToOwnerRequest,
  normalizeOwnerKey,
  resolveIdentity
} from './core/identity.mjs';
import {
  LEGACY_DEFAULTS,
  buildGreetingMessage,
  buildFaqItems,
  isGeneratedMessage,
  resolveMessages
} from './core/messages.mjs';

const configuredBot = {
  identity: {
    botName: 'Aurora',
    responsible: 'Marina Souza',
    companyName: 'Horizonte',
    tone: 'Direto e cordial.',
    aliases: ['Marina', 'Marina Souza', '  ']
  },
  human: { phone: '5511999998888' }
};

test('identidade neutra: sem configuração não fixa pessoa ou empresa', () => {
  const identity = resolveIdentity({});
  assert.equal(identity.botName, NEUTRAL_IDENTITY.botName);
  assert.equal(identity.responsible, NEUTRAL_IDENTITY.responsible);
  assert.equal(identity.companyName, '');
  assert.deepEqual(identity.aliases, []);
  assert.equal(identity.humanPhone, '');
  assert.ok(!/tauan|atualyze/i.test(JSON.stringify(identity)));
});

test('resolveIdentity aceita botConfig completo e objeto identity isolado', () => {
  const fromBot = resolveIdentity(configuredBot);
  assert.equal(fromBot.botName, 'Aurora');
  assert.equal(fromBot.responsible, 'Marina Souza');
  assert.equal(fromBot.companyName, 'Horizonte');
  assert.equal(fromBot.humanPhone, '5511999998888');
  assert.deepEqual(fromBot.aliases, ['Marina', 'Marina Souza']);

  const fromIdentity = resolveIdentity(configuredBot.identity);
  assert.equal(fromIdentity.botName, 'Aurora');
  assert.equal(fromIdentity.responsible, 'Marina Souza');
});

test('identityNames reúne responsável, empresa e apelidos sem duplicar', () => {
  const names = identityNames(resolveIdentity(configuredBot));
  assert.deepEqual(names, ['Marina Souza', 'Horizonte', 'Marina']);
});

test('buildOwnerNamePattern reconhece nomes sem acento e termos neutros', () => {
  const pattern = new RegExp(buildOwnerNamePattern(resolveIdentity(configuredBot)), 'i');
  assert.ok(pattern.test('marina souza'));
  assert.ok(pattern.test('horizonte'));
  assert.ok(pattern.test('responsavel'));
  assert.ok(pattern.test('equipe'));
});

test('chaves internas do responsável mantêm compatibilidade com tauan_self', () => {
  assert.equal(OWNER_SELF_KEY, 'tauan_self');
  assert.ok(OWNER_SELF_ALIASES.includes('tauan_self'));
  assert.ok(isOwnerKey('tauan_self'));
  assert.ok(isOwnerKey('OWNER_SELF'));
  assert.ok(isOwnerKey('sim:owner_self'));
  assert.ok(isOwnerKey('conv_lia_copilot'));
  assert.ok(!isOwnerKey('5511999998888'));
  assert.equal(normalizeOwnerKey(' sim:tauan_self '), 'tauan_self');
});

test('isOwnerContact reconhece chave, nome configurado, apelido e telefone', () => {
  const identity = resolveIdentity(configuredBot);
  const options = { identity, humanPhone: '5511999998888' };

  assert.ok(isOwnerContact('owner_self', options));
  assert.ok(isOwnerContact('Marina', options));
  assert.ok(isOwnerContact('Marina Souza', options));
  assert.ok(isOwnerContact('Horizonte', options));
  assert.ok(isOwnerContact('5511999998888', options));
  assert.ok(isOwnerContact('+55 (11) 99999-8888', options));
  assert.ok(isOwnerContact('11999998888', options));

  assert.ok(!isOwnerContact('5511888887777', options));
  assert.ok(!isOwnerContact('Cliente Qualquer', options));
  assert.ok(!isOwnerContact('', options));
});

test('isOwnerContact mantém a assinatura antiga (target, humanPhone)', () => {
  assert.ok(isOwnerContact('5511999998888', '5511999998888'));
  assert.ok(!isOwnerContact('5511888887777', '5511999998888'));
});

test('isTalkToOwnerRequest reconhece pedido explícito e ignora menção casual', () => {
  const identity = resolveIdentity(configuredBot);

  assert.ok(isTalkToOwnerRequest('quero falar com a Marina', identity));
  assert.ok(isTalkToOwnerRequest('me passa para o responsável', identity));
  assert.ok(isTalkToOwnerRequest('preciso conversar com a equipe', identity));
  assert.ok(isTalkToOwnerRequest('2', identity));
  assert.ok(isTalkToOwnerRequest('atendente', identity));

  assert.ok(!isTalkToOwnerRequest('a Marina me indicou seu contato', identity));
  assert.ok(!isTalkToOwnerRequest('quanto custa o plano?', identity));
  assert.ok(!isTalkToOwnerRequest('', identity));
});

test('mensagens padrão usam a identidade configurada e nunca fixam pessoa', () => {
  const greeting = buildGreetingMessage(configuredBot);
  assert.match(greeting, /\*Aurora\*/);
  assert.match(greeting, /\*Marina Souza\*/);
  assert.match(greeting, /Horizonte/);
  assert.ok(!/tauan|atualyze/i.test(greeting));
});

test('resolveMessages regenera padrões e respeita override real do painel', () => {
  const defaults = resolveMessages(configuredBot);
  assert.equal(defaults.greeting, buildGreetingMessage(configuredBot));
  assert.equal(defaults.plans, defaults.atendimento);
  assert.equal(defaults.talkToTauan, defaults.talkToOwner);

  const custom = resolveMessages({
    ...configuredBot,
    messages: { greeting: 'Mensagem personalizada do painel.' }
  });
  assert.equal(custom.greeting, 'Mensagem personalizada do painel.');

  const legacy = resolveMessages({
    ...configuredBot,
    messages: { greeting: LEGACY_DEFAULTS.greeting }
  });
  assert.equal(legacy.greeting, buildGreetingMessage(configuredBot));
});

test('isGeneratedMessage identifica texto padrão, legado e override', () => {
  const identity = resolveIdentity(configuredBot);
  assert.ok(isGeneratedMessage(buildGreetingMessage(configuredBot), 'greeting', identity));
  assert.ok(isGeneratedMessage(LEGACY_DEFAULTS.greeting, 'greeting', identity));
  assert.ok(!isGeneratedMessage('Texto feito à mão no painel.', 'greeting', identity));
  assert.equal(isGeneratedMessage('qualquer coisa', 'desconhecido', identity), false);
});

test('buildFaqItems inclui o responsável configurado nas chaves de transbordo', () => {
  const items = buildFaqItems(configuredBot);
  const talk = items.find(item => item.keys.includes('responsavel'));
  assert.ok(talk);
  assert.ok(talk.keys.includes('falar com marina souza'));
  assert.match(talk.answer, /Marina Souza/);
});
