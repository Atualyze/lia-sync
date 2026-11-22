import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearModelCapabilities,
  getModelCapabilities,
  learnModelCapability,
  extractMessageContent,
  extractJsonFromReasoning,
  applyReasoningControls,
  buildProviderCandidateModels,
  computeAttemptTimeoutMs
} from './ai/resilience.mjs';
import { call } from './ai/call.mjs';
import { config } from './config.mjs';
import { opened, failures } from './ai/state.mjs';
import { toolGerenciarAgendaGoogle, computeSuggestedSlots } from './tools/gerenciar_agenda_google.mjs';
import { filterReply, splitReply } from './safety.mjs';
import { processMaintenance } from './maintenance.mjs';
import { formatOutgoingMessage } from './core/format.mjs';

test('getModelCapabilities e learnModelCapability aprendem capacidades em runtime', () => {
  clearModelCapabilities();
  const groqOss = getModelCapabilities('groq', 'openai/gpt-oss-20b');
  assert.equal(groqOss.isReasoning, true);
  assert.equal(groqOss.supportsResponseFormat, false);

  const nimNemotron = getModelCapabilities('nvidia', 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.equal(nimNemotron.isReasoning, true);
  assert.equal(nimNemotron.supportsThinkingToggle, true);

  const customModel = getModelCapabilities('meu_provedor', 'custom-v2');
  assert.equal(customModel.supportsNativeTools, true);
  learnModelCapability('meu_provedor', 'custom-v2', { supportsNativeTools: false, isReasoning: true });
  const updated = getModelCapabilities('meu_provedor', 'custom-v2');
  assert.equal(updated.supportsNativeTools, false);
  assert.equal(updated.isReasoning, true);
});

test('extractMessageContent suporta string, array de blocos e output_text', () => {
  assert.equal(extractMessageContent({ content: '  Olá!  ' }), 'Olá!');
  assert.equal(
    extractMessageContent({ content: [{ type: 'text', text: 'Linha 1' }, { type: 'text', text: 'Linha 2' }] }),
    'Linha 1\nLinha 2'
  );
  assert.equal(extractMessageContent({ output_text: 'Resposta direta' }), 'Resposta direta');
  assert.equal(
    extractJsonFromReasoning({ reasoning_content: 'pensando... {"reply":"Oi!","intent":"saudacao"}' }),
    '{"reply":"Oi!","intent":"saudacao"}'
  );
});

test('applyReasoningControls aplica parâmetro correto por família de provedor', () => {
  const groqBody = applyReasoningControls({ model: 'openai/gpt-oss-20b' }, { provider: 'groq', model: 'openai/gpt-oss-20b' });
  assert.equal(groqBody.reasoning_effort, 'low');

  const nimBody = applyReasoningControls({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b' }, { provider: 'nvidia', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' });
  assert.deepEqual(nimBody.chat_template_kwargs, { enable_thinking: false });

  const orBody = applyReasoningControls({ model: 'openrouter/free' }, { provider: 'openrouter', model: 'openrouter/free' });
  assert.deepEqual(orBody.reasoning, { effort: 'low' });
});

test('buildProviderCandidateModels inclui rede de segurança sem duplicatas e respeita openrouterFreeOnly', () => {
  const groqModels = buildProviderCandidateModels({ provider: 'groq', primaryModel: 'openai/gpt-oss-20b' });
  assert.deepEqual(groqModels, ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);

  const nimModels = buildProviderCandidateModels({ provider: 'nvidia', primaryModel: 'nvidia/nemotron-3.5-lightning-30b-a3b' });
  assert.deepEqual(nimModels, ['nvidia/nemotron-3.5-lightning-30b-a3b', 'meta/llama-3.3-70b-instruct']);

  const orModels = buildProviderCandidateModels({
    provider: 'openrouter',
    primaryModel: 'openrouter/free',
    configuredFallbacks: ['openai/gpt-4o', 'qwen/qwen3:free'],
    openrouterFreeOnly: true
  });
  assert.deepEqual(orModels, ['openrouter/free', 'qwen/qwen3:free']);
});

test('computeAttemptTimeoutMs limita tentativa intermediária a 15s e preserva tempo restante na última', () => {
  assert.equal(computeAttemptTimeoutMs({ remainingMs: 30000, providerTimeoutMs: 30000, hasMoreCandidates: true }), 15000);
  assert.equal(computeAttemptTimeoutMs({ remainingMs: 25000, providerTimeoutMs: 30000, hasMoreCandidates: false }), 25000);
});

test('call("groq") faz fallback automático intra-provedor em empty_reply para llama-3.3-70b-versatile', async () => {
  clearModelCapabilities();
  opened.clear();
  failures.clear();
  const prevKey = config.groqKey;
  const prevFetch = globalThis.fetch;
  config.groqKey = 'gsk_test_fake_key_1234567890';
  const calledModels = [];

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calledModels.push(body.model);
    if (body.model === 'openai/gpt-oss-20b') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '', reasoning: 'pensando sem fechar resposta' } }] })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: body.model,
        choices: [{ message: { content: '{"reply":"Respondido pelo fallback intra-provedor!","intent":"outro"}' } }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }
      })
    };
  };

  try {
    const res = await call('groq', {
      system: 'Você é a Lia.',
      history: [],
      userText: 'Olá',
      fixedModel: 'openai/gpt-oss-20b',
      deadline: Date.now() + 20000
    });
    assert.ok(res);
    assert.equal(res.model, 'llama-3.3-70b-versatile');
    assert.ok(res.raw.includes('Respondido pelo fallback intra-provedor!'));
    assert.ok(calledModels.includes('openai/gpt-oss-20b'));
    assert.ok(calledModels.includes('llama-3.3-70b-versatile'));
  } finally {
    config.groqKey = prevKey;
    globalThis.fetch = prevFetch;
  }
});

test('gerenciar_agenda_google respeita businessHours (bloqueia domingo e fora do horário)', async () => {
  const botConfig = {
    behavior: {
      businessHours: {
        enabled: true,
        timezone: 'America/Sao_Paulo',
        start: '09:00',
        end: '18:00',
        weekdays: [1, 2, 3, 4, 5]
      }
    }
  };
  // 2026-11-22 é domingo!
  const freeSun = await toolGerenciarAgendaGoogle.execute(
    { action: 'consultar_livres', date: '2026-11-22' },
    { botConfig }
  );
  assert.equal(freeSun.closedDay, true);
  assert.equal(freeSun.weekdayName, 'domingo');
  assert.deepEqual(freeSun.availableSlots, []);

  const createSun = await toolGerenciarAgendaGoogle.execute(
    { action: 'criar_evento', date: '2026-11-22', startTime: '15:00', summary: 'Teste' },
    { botConfig }
  );
  assert.equal(createSun.success, false);
  assert.equal(createSun.error, 'outside_business_hours');
  assert.equal(createSun.weekdayName, 'domingo');

  const createLateMon = await toolGerenciarAgendaGoogle.execute(
    { action: 'criar_evento', date: '2026-11-23', startTime: '20:00', summary: 'Teste' },
    { botConfig }
  );
  assert.equal(createLateMon.success, false);
  assert.equal(createLateMon.error, 'outside_business_hours');

  const suggestions = computeSuggestedSlots({
    startDate: new Date('2026-11-22T12:00:00.000Z'),
    days: 3,
    allowedWeekdays: [1, 2, 3, 4, 5],
    workdayStart: '09:00',
    workdayEnd: '18:00',
    nowMs: Date.parse('2026-11-22T12:00:00.000Z')
  });
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every(s => s.isoDate !== '2026-11-22'));
  assert.equal(suggestions[0].weekdayName, 'segunda-feira');
});

test('filterReply converte timestamps ISO crus para data/hora legível em BRT', () => {
  const res = filterReply('Encontrei o horário às 2026-11-22T15:00:00-03:00. Posso confirmar?');
  assert.ok(!res.text.includes('2026-11-22T15:00:00-03:00'));
  assert.ok(res.text.includes('22/11/2026 às 15:00'));
});

test('business.hoursConfig.restrictScheduling permite Lia 24/7 com agenda restrita ao expediente da loja', async () => {
  // Lia 24/7 (enabled: false) + agenda restrita (restrictScheduling: true) -> bloqueia domingo
  const cfgRestricted = {
    business: {
      hoursConfig: {
        enabled: false,
        restrictScheduling: true,
        timezone: 'America/Sao_Paulo',
        start: '08:00',
        end: '18:00',
        weekdays: [1, 2, 3, 4, 5]
      }
    }
  };
  const sunBlocked = await toolGerenciarAgendaGoogle.execute(
    { action: 'criar_evento', date: '2026-11-22', startTime: '15:00', summary: 'Reunião' },
    { botConfig: cfgRestricted }
  );
  assert.equal(sunBlocked.success, false);
  assert.equal(sunBlocked.error, 'outside_business_hours');

  // Lia 24/7 (enabled: false) + agenda livre (restrictScheduling: false) -> não bloqueia por outside_business_hours
  const cfgOpen = {
    business: {
      hoursConfig: {
        enabled: false,
        restrictScheduling: false,
        timezone: 'America/Sao_Paulo',
        start: '08:00',
        end: '18:00',
        weekdays: [1, 2, 3, 4, 5]
      }
    }
  };
  const sunOpen = await toolGerenciarAgendaGoogle.execute(
    { action: 'criar_evento', date: '2026-11-22', startTime: '15:00', summary: 'Reunião' },
    { botConfig: cfgOpen }
  );
  assert.notEqual(sunOpen.error, 'outside_business_hours');
});

test('processMaintenance executa onPostponedResume na abertura do expediente quando autoResumeOnOpen=true', async () => {
  const resumed = [];
  const notices = [];
  const store = {
    sessions: {
      '5588921694598': {
        phone: '5588921694598',
        clientName: 'Atualyze',
        human: false,
        pendingTurnPostponedUntil: '2026-11-23T11:00:00.000Z',
        history: [{ role: 'user', content: 'Quero agendar amanhã', createdAt: '2026-11-22T16:00:00.000Z' }]
      }
    },
    markDirty() {}
  };
  await processMaintenance({
    store,
    now: () => Date.parse('2026-11-23T11:01:00.000Z'),
    notify: async (msg) => { notices.push(msg); },
    autoResumeOnOpen: true,
    onPostponedResume: async (sess) => { resumed.push(sess.phone); return { continued: true }; },
    disableInactivityPings: true,
    enableLeadFollowUp: false
  });
  assert.deepEqual(resumed, ['5588921694598']);
  assert.equal(store.sessions['5588921694598'].pendingTurnPostponedUntil, null);
  assert.ok(notices.some(n => n.includes('Retomada Automática')));
});

test('formatOutgoingMessage preserva Pix EMV Copia e Cola intacto sem quebrar ou truncar', () => {
  const payload = '00020126570014br.gov.bcb.pix0114+55889983400850217Pagamento via Pix520400005303986540510.005802BR5911Tauan Pires6009Sao Paulo62070503***6304ABCD';
  const msg = `💳 *Cobrança Pix autorizada e gerada pela equipe:*\n\n• *Valor:* R$ 10,00\n\n• *Copia e Cola:*\n${payload}\n\n_O QR Code também foi enviado._`;
  const formatted = formatOutgoingMessage(msg);
  assert.ok(formatted.includes(payload), `Payload Pix corrompido: ${formatted}`);
  assert.ok(!formatted.includes('br. gov.'));
});

test('filterReply bloqueia código Pix fictício (1234567890) e placeholders como [link_para_qr_code]', () => {
  const fake = filterReply('Código Pix: 1234567890\n\nPara facilitar, aqui está o QR Code: [link_para_qr_code]');
  assert.equal(fake.blocked, true);
  assert.ok(fake.violations.includes('pix_ficticio'));

  const question = filterReply('Claro! Você prefere que eu envie *só a chave Pix* ou gere o *código Pix copia e cola*?');
  assert.equal(question.blocked, false);

  const realPayload = '00020126570014br.gov.bcb.pix0114+55889983400850217Pagamento via Pix520400005303986540510.005802BR5911Tauan Pires6009Sao Paulo62070503***6304ABCD';
  const real = filterReply(`• *Valor:* R$ 10,00\n• *Copia e Cola:*\n${realPayload}`, { allowedPrices: new Set(['10.00', '10,00']), strictPrices: true });
  assert.equal(real.blocked, false);

  const parts = splitReply(real.text);
  assert.equal(parts.length, 2);
  assert.equal(parts[1], realPayload);
});
