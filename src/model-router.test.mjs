import test from 'node:test';
import assert from 'node:assert/strict';
import { decidirModeloPorContexto } from './model-router.mjs';

const publishedModel = 'gemini-3.8-flash';

test('model-router: classifica saudações e mensagens curtas como lite sem trocar o modelo publicado', () => {
  for (const userText of ['Oi, tudo bem?', 'bom dia!', 'qual o link do portal?']) {
    const result = decidirModeloPorContexto({ userText, configuredModel: publishedModel });
    assert.equal(result.model, publishedModel);
    assert.equal(result.tier, 'lite');
  }
});

test('model-router: classifica comandos de ferramentas como flash sem trocar o modelo publicado', () => {
  const r1 = decidirModeloPorContexto({
    userText: 'Gostaria de agendar um retorno para amanhã às 14h com o setor comercial',
    isSuperAgent: true,
    configuredModel: publishedModel
  });
  assert.equal(r1.model, publishedModel);
  assert.equal(r1.tier, 'flash');

  const r2 = decidirModeloPorContexto({
    userText: 'Pode me transferir para o financeiro?',
    configuredModel: publishedModel
  });
  assert.equal(r2.model, publishedModel);
});

test('model-router: classifica análise estratégica do responsável como pro sem trocar o modelo publicado', () => {
  const r1 = decidirModeloPorContexto({
    userText: 'Lia, faça uma análise profunda e consolide o relatório estratégico de vendas do mês',
    isOwner: true,
    configuredModel: publishedModel
  });
  assert.equal(r1.model, publishedModel);
  assert.equal(r1.tier, 'pro');

  const r2 = decidirModeloPorContexto({
    userText: 'Lia, qual a situação da fila agora?',
    isOwner: true,
    configuredModel: publishedModel
  });
  assert.equal(r2.model, publishedModel);
});

test('model-router: respeita modelo fixo quando autoRoutingEnabled é falso ou OpenRouter', () => {
  const r1 = decidirModeloPorContexto({
    userText: 'Oi',
    autoRoutingEnabled: false,
    configuredModel: 'gemini-2.5-pro'
  });
  assert.equal(r1.model, 'gemini-2.5-pro');

  const r2 = decidirModeloPorContexto({
    userText: 'Oi',
    configuredModel: 'google/gemma-4-31b:free'
  });
  assert.equal(r2.model, 'google/gemma-4-31b:free');
});

test('model-router: mensagens curtas que exigem busca web, agenda, lembretes ou documentos não caem no lite', () => {
  const webShort = decidirModeloPorContexto({ userText: 'qual a cotação do dólar hoje?', configuredModel: publishedModel });
  assert.equal(webShort.tier, 'flash');
  assert.equal(webShort.model, publishedModel);
  assert.ok(webShort.capabilities.includes('web_search'));

  const reminderShort = decidirModeloPorContexto({ userText: 'me lembra amanhã às 10h', configuredModel: publishedModel });
  assert.equal(reminderShort.tier, 'flash');
  assert.ok(reminderShort.capabilities.includes('tools'));

  const calendarShort = decidirModeloPorContexto({ userText: 'tem horário livre hoje?', configuredModel: publishedModel });
  assert.equal(calendarShort.tier, 'flash');
  assert.ok(calendarShort.capabilities.includes('tools'));

  const docContextShort = decidirModeloPorContexto({
    userText: 'qual é o valor total?',
    configuredModel: publishedModel,
    system: 'Você é a Lia.\n[ULTIMO_DOCUMENTO_ANALISADO_NA_SESSAO]\n{"summary":"Recibo R$ 500"}\n[/ULTIMO_DOCUMENTO_ANALISADO_NA_SESSAO]'
  });
  assert.equal(docContextShort.tier, 'flash');
  assert.ok(docContextShort.capabilities.includes('document_context'));
});
