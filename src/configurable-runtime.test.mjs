import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { AdminConfigStore, DEFAULT_BOT_CONFIG, validateBotConfig } from './admin-config.mjs';
import { toolGerenciarAgendaGoogle } from './tools/gerenciar_agenda_google.mjs';

test('configuração padrão expõe memória, voz e agenda ajustáveis', () => {
  assert.equal(DEFAULT_BOT_CONFIG.ai.agentMode, 'super_agente');
  assert.equal(DEFAULT_BOT_CONFIG.ai.enableToolCalling, true);
  assert.equal(DEFAULT_BOT_CONFIG.ai.autoRouting, true);
  assert.equal(DEFAULT_BOT_CONFIG.ai.contextTurns, 24);
  assert.equal(DEFAULT_BOT_CONFIG.voice.requestTimeoutMs, 45000);
  assert.equal(DEFAULT_BOT_CONFIG.voice.deliveryMode, 'audio_and_text');
  assert.equal(DEFAULT_BOT_CONFIG.voice.sendTranscriptionWithAudio, true);
  assert.equal(DEFAULT_BOT_CONFIG.integrations.googleCalendar.enabled, true);
  assert.deepEqual(validateBotConfig(DEFAULT_BOT_CONFIG), []);
});

test('rascunho publicado pelo painel é persistido e carregado com parâmetros novos', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-config-'));
  const file = path.join(dir, 'bot-config.json');
  const first = new AdminConfigStore(file);
  await first.load();
  const updated = await first.updateDraft({ ai: { contextTurns: 48, maxStoredHistory: 200 }, voice: { speed: 1.15, deliveryMode: 'audio_only' }, integrations: { googleCalendar: { defaultEventDurationMinutes: 45 } } });
  assert.equal(updated.ok, true);
  const published = await first.publish('test');
  assert.equal(published.ok, true);
  const second = new AdminConfigStore(file);
  await second.load();
  assert.equal(second.active.ai.contextTurns, 48);
  assert.equal(second.active.ai.maxStoredHistory, 200);
  assert.equal(second.active.voice.speed, 1.15);
  assert.equal(second.active.voice.deliveryMode, 'audio_only');
  assert.equal(second.active.voice.sendTranscriptionWithAudio, false);
  assert.equal(second.active.integrations.googleCalendar.defaultEventDurationMinutes, 45);
});

test('autosave com catálogo vazio não apaga o modelo ativo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-model-'));
  const store = new AdminConfigStore(path.join(dir, 'bot-config.json'));
  await store.load();
  const model = store.draft.ai.activeModel;
  const result = await store.updateDraft({ ai: { activeModel: '' } });
  assert.equal(result.ok, true);
  assert.equal(store.draft.ai.activeModel, model);
  await store.updateDraft({ business: { greeting: 'autosave preserva modelo' } });
  assert.equal((await store.publish('test')).ok, true);
});

test('agenda nunca informa sucesso sem integração real ou mock de teste', async () => {
  const oldEnv = { node: process.env.NODE_ENV, mock: process.env.GOOGLE_CALENDAR_MOCK, key: process.env.GOOGLE_CALENDAR_API_KEY, token: process.env.GOOGLE_CALENDAR_ACCESS_TOKEN };
  process.env.NODE_ENV = 'production';
  delete process.env.GOOGLE_CALENDAR_MOCK;
  delete process.env.GOOGLE_CALENDAR_API_KEY;
  delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  const result = await toolGerenciarAgendaGoogle.execute({ action: 'consultar_livres', date: '2026-11-12' }, { botConfig: { integrations: { googleCalendar: { enabled: true } } } });
  assert.equal(result.success, false);
  assert.equal(result.error, 'google_calendar_unavailable');
  if (oldEnv.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv.node;
  if (oldEnv.mock === undefined) delete process.env.GOOGLE_CALENDAR_MOCK; else process.env.GOOGLE_CALENDAR_MOCK = oldEnv.mock;
  if (oldEnv.key === undefined) delete process.env.GOOGLE_CALENDAR_API_KEY; else process.env.GOOGLE_CALENDAR_API_KEY = oldEnv.key;
  if (oldEnv.token === undefined) delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN; else process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = oldEnv.token;
});

test('agenda respeita desativação no painel', async () => {
  const result = await toolGerenciarAgendaGoogle.execute({ action: 'consultar_livres', date: '2026-11-12' }, { botConfig: { integrations: { googleCalendar: { enabled: false } } } });
  assert.equal(result.success, false);
  assert.equal(result.error, 'google_calendar_disabled');
});

test('voice: deliveryMode e sendTranscriptionWithAudio sincronizam e validam', () => {
  assert.deepEqual(validateBotConfig({ ...DEFAULT_BOT_CONFIG, voice: { ...DEFAULT_BOT_CONFIG.voice, deliveryMode: 'invalido' } }), ['O modo de entrega de áudio deve ser "audio_and_text" ou "audio_only".']);
  assert.deepEqual(validateBotConfig({ ...DEFAULT_BOT_CONFIG, voice: { ...DEFAULT_BOT_CONFIG.voice, deliveryMode: 'audio_only', sendTranscriptionWithAudio: false } }), []);
  assert.deepEqual(validateBotConfig({ ...DEFAULT_BOT_CONFIG, voice: { ...DEFAULT_BOT_CONFIG.voice, deliveryMode: 'audio_and_text', sendTranscriptionWithAudio: true } }), []);
});
