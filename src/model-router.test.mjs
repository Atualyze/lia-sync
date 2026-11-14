import test from 'node:test';
import assert from 'node:assert/strict';
import { decidirModeloPorContexto } from './model-router.mjs';

test('model-router: roteia saudações e mensagens curtas para flash-lite', () => {
  const r1 = decidirModeloPorContexto({ userText: 'Oi, tudo bem?' });
  assert.equal(r1.model, 'gemini-3.5-flash-lite');
  assert.equal(r1.tier, 'lite');

  const r2 = decidirModeloPorContexto({ userText: 'bom dia!' });
  assert.equal(r2.model, 'gemini-3.5-flash-lite');

  const r3 = decidirModeloPorContexto({ userText: 'qual o link do portal?' });
  assert.equal(r3.model, 'gemini-3.5-flash-lite');
});

test('model-router: roteia comandos de ferramentas e super agente para flash', () => {
  const r1 = decidirModeloPorContexto({
    userText: 'Gostaria de agendar um retorno para amanhã às 14h com o setor comercial',
    isSuperAgent: true
  });
  assert.equal(r1.model, 'gemini-3.8-flash');
  assert.equal(r1.tier, 'flash');

  const r2 = decidirModeloPorContexto({
    userText: 'Pode me transferir para o financeiro?',
    isSuperAgent: false
  });
  assert.equal(r2.model, 'gemini-3.8-flash');
});

test('model-router: roteia análises estratégicas do Copiloto do Tauan para pro', () => {
  const r1 = decidirModeloPorContexto({
    userText: 'Lia, faça uma análise profunda e consolide o relatório estratégico de vendas do mês',
    isTauan: true
  });
  assert.equal(r1.model, 'gemini-pro-latest');
  assert.equal(r1.tier, 'pro');

  const r2 = decidirModeloPorContexto({
    userText: 'Lia, qual a situação da fila agora?',
    isTauan: true
  });
  assert.equal(r2.model, 'gemini-3.8-flash'); // Modelo configurado padrão para operacão simples
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

test('model-router: mensagens curtas que exigem busca web, agenda, lembretes ou documentos NUNCA caem no lite', () => {
  const webShort = decidirModeloPorContexto({
    userText: 'qual a cotação do dólar hoje?'
  });
  assert.equal(webShort.tier, 'flash');
  assert.equal(webShort.model, 'gemini-3.8-flash');
  assert.ok(webShort.capabilities.includes('web_search'));

  const reminderShort = decidirModeloPorContexto({
    userText: 'me lembra amanhã às 10h'
  });
  assert.equal(reminderShort.tier, 'flash');
  assert.ok(reminderShort.capabilities.includes('tools'));

  const calendarShort = decidirModeloPorContexto({
    userText: 'tem horário livre hoje?'
  });
  assert.equal(calendarShort.tier, 'flash');
  assert.ok(calendarShort.capabilities.includes('tools'));

  const docContextShort = decidirModeloPorContexto({
    userText: 'qual é o valor total?',
    system: 'Você é a Lia.\n[ULTIMO_DOCUMENTO_ANALISADO_NA_SESSAO]\n{"summary":"Recibo R$ 500"}\n[/ULTIMO_DOCUMENTO_ANALISADO_NA_SESSAO]'
  });
  assert.equal(docContextShort.tier, 'flash');
  assert.ok(docContextShort.capabilities.includes('document_context'));
});

