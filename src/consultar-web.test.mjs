import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { ALL_TOOLS, getGeminiToolDeclarations, isClientToolAllowed, executeToolCall } from './tools/index.mjs';
import { toolConsultarWeb } from './tools/consultar_web.mjs';
import { createFlow } from './flow.mjs';
import { SessionStore } from './sessions.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';

const config = { ai: { agentMode: 'super_agente', enableToolCalling: true }, identity: { botName: 'Lia', responsible: 'Rafa' } };
async function makeStore(label) {
  const store = new SessionStore(path.join(os.tmpdir(), `consultar-web-${label}-${Date.now()}-${Math.random()}.json`));
  await store.load();
  return store;
}

test('consultar_web está no catálogo, nas declarações Gemini e na allowlist client', () => {
  assert.equal(ALL_TOOLS.some(tool => tool.name === 'consultar_web'), true);
  assert.equal(getGeminiToolDeclarations()[0].functionDeclarations.some(tool => tool.name === 'consultar_web'), true);
  assert.equal(isClientToolAllowed('consultar_web'), true);
  assert.equal(isClientToolAllowed('gerenciar_agenda_google'), false);
});

test('consultar_web distingue consulta inválida, timeout e erro HTTP', async () => {
  assert.equal((await toolConsultarWeb.execute({ query: '' })).error.code, 'INVALID_QUERY');
  const timeout = await toolConsultarWeb.execute({ query: 'tempo agora' }, { searchWebWithGemini: async () => ({ error: { code: 'WEB_SEARCH_TIMEOUT', message: 'timeout mock' } }) });
  assert.equal(timeout.success, false);
  assert.equal(timeout.error.code, 'WEB_SEARCH_TIMEOUT');
  const httpError = await toolConsultarWeb.execute({ query: 'tempo agora' }, { searchWebWithGemini: async () => ({ error: { code: 'WEB_SEARCH_HTTP_503', message: 'erro mock' } }) });
  assert.equal(httpError.error.code, 'WEB_SEARCH_HTTP_503');
});

test('consultar_web usa a mensagem original se o modelo omitir query', async () => {
  let received = '';
  const result = await toolConsultarWeb.execute({}, {
    userText: 'faça uma consulta web sobre Godzilla',
    searchWebWithGemini: async query => {
      received = query;
      return { text: 'resultado mockado', queries: [], sources: [] };
    }
  });
  assert.equal(result.success, true);
  assert.equal(received, 'faça uma consulta web sobre Godzilla');
});

test('fluxo client executa consultar_web, entrega dado não confiável ao modelo e não entra em loop', async () => {
  const store = await makeStore('client');
  let calls = 0;
  const ai = {
    searchWebWithGemini: async () => ({ text: 'cotação mockada', queries: ['cotação hoje'], sources: [{ title: 'Cotação', uri: 'https://example.test/cotacao' }] }),
    askAI: async ({ system }) => {
      calls += 1;
      if (calls === 1) return { reply: 'vou pesquisar', intent: 'duvida', tool_calls: [{ name: 'consultar_web', args: { query: 'cotação hoje' } }] };
      assert.match(system, /UNTRUSTED_WEB_SEARCH_JSON/);
      assert.match(system, /https:\/\/example\.test\/cotacao/);
      return { reply: 'A cotação consultada ficou dentro do esperado.\n\nFontes: https://example.test/cotacao', intent: 'duvida', tool_calls: [{ name: 'consultar_web', args: { query: 'não executar novamente' } }] };
    }
  };
  const flow = createFlow({ store, ai, getBotConfig: () => config, faq: async () => [], now: () => Date.now() });
  const reply = await flow.process({ phone: '5588999991111', text: 'qual a cotação hoje?' });
  assert.match(reply, /Fontes/);
  assert.equal(calls, 2);
});

test('fluxo owner executa consultar_web e retorna síntese com fontes sem reexecutar tool_call', async () => {
  const store = await makeStore('owner');
  let calls = 0;
  const ai = {
    searchWebWithGemini: async () => ({ text: 'notícia mockada', queries: ['notícia hoje'], sources: [{ title: 'Notícia', uri: 'https://example.test/noticia' }] }),
    askAI: async ({ system }) => {
      calls += 1;
      if (calls === 1) return { reply: 'pesquisando', intent: 'duvida', tool_calls: [{ name: 'consultar_web', args: { query: 'notícia hoje' } }] };
      assert.match(system, /UNTRUSTED_WEB_SEARCH_JSON/);
      return { reply: 'Resumo da notícia.\n\nFontes: https://example.test/noticia', intent: 'duvida', tool_calls: [{ name: 'consultar_web', args: { query: 'loop' } }] };
    }
  };
  const flow = createFlow({ store, ai, getBotConfig: () => config, now: () => Date.now() });
  const reply = await flow.process({ phone: OWNER_SELF_KEY, text: 'pesquise notícia hoje' });
  assert.match(reply, /Fontes/);
  assert.equal(calls, 2);
});

test('executeToolCall preserva bloqueio de outras tools para client', async () => {
  const result = await executeToolCall('gerenciar_agenda_google', {}, { actor: 'client' });
  assert.match(result.error, /indisponível/);
});
