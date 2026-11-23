import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { buildGoogleApiUrl, createGoogleHttp, GoogleHttpError, UNCERTAIN_WRITE_WARNING } from './tools/google_http.mjs';
import { toolGerenciarGmailGoogle, buildRawMimeDraft } from './tools/gerenciar_gmail_google.mjs';
import { computeSuggestedSlots } from './tools/gerenciar_agenda_google.mjs';
import { toolGerenciarDriveGoogle } from './tools/gerenciar_drive_google.mjs';
import { executeToolCall, isClientToolAllowed } from './tools/index.mjs';
import { redactSecrets, redactObject } from './ops/log-redaction.mjs';
import { createEventLoopMonitor, classifyEventLoopStall } from './ops/event-loop-monitor.mjs';
import { sanitizeInventedLinks, filterReply } from './safety.mjs';
import { CopilotTaskStore } from './copilot-tasks.mjs';

test('Package 1 - google_http: bloqueia host/caminho inválido e redirect', async () => {
  assert.throws(() => buildGoogleApiUrl({ host: 'evil.com', path: '/v1/documents/1' }), /não permitido/i);
  assert.throws(() => buildGoogleApiUrl({ host: 'docs.googleapis.com', path: '/v1/documents/../../etc/passwd' }), /inválido/i);
  assert.throws(() => buildGoogleApiUrl({ host: 'gmail.googleapis.com', path: '/calendar/v3/events' }), /Prefixo de rota/i);

  const http = createGoogleHttp({
    accessToken: 'fake-token',
    retryDelayMs: 1,
    fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://evil.com' } })
  });
  await assert.rejects(
    () => http.send({ method: 'GET', host: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages' }),
    err => err instanceof GoogleHttpError && err.code === 'redirect_blocked'
  );
});

test('Package 1 - google_http: faz retry só em GET (503) e NUNCA em POST de escrita', async () => {
  let getCalls = 0;
  const httpGet = createGoogleHttp({
    accessToken: 'tok',
    retryDelayMs: 1,
    fetchImpl: async () => {
      getCalls += 1;
      if (getCalls === 1) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  const res = await httpGet.send({ method: 'GET', host: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages' });
  assert.equal(getCalls, 2);
  assert.equal(res.ok, true);

  let postCalls = 0;
  const httpPost = createGoogleHttp({
    accessToken: 'tok',
    retryDelayMs: 1,
    fetchImpl: async () => {
      postCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'Backend down' } }), { status: 503 });
    }
  });
  await assert.rejects(
    () => httpPost.send({ method: 'POST', host: 'gmail.googleapis.com', path: '/gmail/v1/users/me/drafts', body: {} }),
    err => err instanceof GoogleHttpError && err.uncertainWrite === true && err.message.includes(UNCERTAIN_WRITE_WARNING)
  );
  assert.equal(postCalls, 1);
});

test('Package 1 - gerenciar_gmail_google: busca, lê, cria rascunho e bloqueia para cliente', async () => {
  assert.equal(isClientToolAllowed('gerenciar_gmail_google'), false);
  const blocked = await executeToolCall('gerenciar_gmail_google', { acao: 'buscar_mensagens' }, { actor: 'client' });
  assert.equal(blocked.success, false);
  assert.equal(blocked.code, 'tool_not_allowed');

  const prevToken = process.env.GOOGLE_GMAIL_ACCESS_TOKEN;
  process.env.GOOGLE_GMAIL_ACCESS_TOKEN = 'test-gmail-token';
  try {
    const bodyBase64 = Buffer.from('Olá Tauan, segue o orçamento atualizado.', 'utf8').toString('base64url');
    const fetchImpl = async (url, init) => {
      if (url.includes('/messages?')) {
        return new Response(JSON.stringify({ messages: [{ id: 'm1', threadId: 't1' }] }), { status: 200 });
      }
      if (url.includes('/messages/m1') && url.includes('format=metadata')) {
        return new Response(JSON.stringify({
          id: 'm1',
          threadId: 't1',
          snippet: 'Olá Tauan...',
          labelIds: ['UNREAD'],
          payload: {
            headers: [
              { name: 'From', value: 'cliente@empresa.com' },
              { name: 'Subject', value: 'Orçamento' },
              { name: 'Date', value: 'Sun, 22 Nov 2026 07:00:00 -0300' }
            ]
          }
        }), { status: 200 });
      }
      if (url.includes('/messages/m1') && url.includes('format=full')) {
        return new Response(JSON.stringify({
          id: 'm1',
          threadId: 't1',
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'Subject', value: 'Orçamento' }, { name: 'From', value: 'cliente@empresa.com' }],
            body: { data: bodyBase64 }
          }
        }), { status: 200 });
      }
      if (url.includes('/drafts') && init.method === 'POST') {
        return new Response(JSON.stringify({ id: 'd1', message: { id: 'm2', threadId: 't1' } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const search = await toolGerenciarGmailGoogle.execute({ acao: 'buscar_mensagens', busca: 'Orçamento' }, { fetchImpl });
    assert.equal(search.success, true);
    assert.equal(search.total, 1);
    assert.equal(search.messages[0].subject, 'Orçamento');
    assert.equal(search.messages[0].unread, true);

    const read = await toolGerenciarGmailGoogle.execute({ acao: 'ler_mensagem', messageId: 'm1' }, { fetchImpl });
    assert.equal(read.success, true);
    assert.match(read.body, /orçamento atualizado/);

    const draft = await toolGerenciarGmailGoogle.execute({
      acao: 'criar_rascunho',
      para: 'cliente@empresa.com',
      assunto: 'Retorno sobre orçamento',
      corpo: 'Oi! Segue o retorno.'
    }, { fetchImpl });
    assert.equal(draft.success, true);
    assert.equal(draft.draftId, 'd1');
    assert.match(draft.message, /NÃO foi enviado automaticamente/i);

    const rawMime = Buffer.from(buildRawMimeDraft({ to: 'a@b.com', subject: 'Ação rápida', body: 'Oi' }), 'base64url').toString('utf8');
    assert.match(rawMime, /Subject: =\?UTF-8\?B\?/);
  } finally {
    if (prevToken === undefined) delete process.env.GOOGLE_GMAIL_ACCESS_TOKEN;
    else process.env.GOOGLE_GMAIL_ACCESS_TOKEN = prevToken;
  }
});

test('Package 1 - gerenciar_agenda_google: computeSuggestedSlots pula blocos ocupados', () => {
  const startDate = new Date('2026-11-23T12:00:00.000Z');
  const suggestions = computeSuggestedSlots({
    startDate,
    days: 2,
    durationMinutes: 60,
    stepMinutes: 60,
    workdayStart: '09:00',
    workdayEnd: '12:00',
    timezone: 'America/Sao_Paulo',
    busyIntervals: [
      { start: '2026-11-23T12:00:00.000Z', end: '2026-11-23T13:00:00.000Z' } // 09:00-10:00 BRT
    ],
    maxSuggestions: 4,
    nowMs: Date.parse('2026-11-23T00:00:00.000Z')
  });
  assert.equal(suggestions.length, 4);
  assert.equal(suggestions[0].startTime, '10:00');
  assert.equal(suggestions[1].startTime, '11:00');
  assert.equal(suggestions[2].isoDate, '2026-11-24');
  assert.equal(suggestions[2].startTime, '09:00');
});

test('Package 1 - gerenciar_drive_google: atualizar_documento funciona para dono e bloqueia cliente', async () => {
  const clientBlocked = await toolGerenciarDriveGoogle.execute({ acao: 'atualizar_documento', fileId: 'doc1', texto: 'Oi' }, { actor: 'client' });
  assert.equal(clientBlocked.success, false);
  assert.equal(clientBlocked.error, 'forbidden_for_client');

  const prevToken = process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
  process.env.GOOGLE_DRIVE_ACCESS_TOKEN = 'test-docs-token';
  try {
    let capturedBody = null;
    const fetchImpl = async (url, init) => {
      assert.match(url, /docs\.googleapis\.com\/v1\/documents\/doc1:batchUpdate$/);
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ replies: [{ replaceAllText: { occurrencesChanged: 2 } }] }), { status: 200 });
    };
    const res = await toolGerenciarDriveGoogle.execute({
      acao: 'atualizar_documento',
      fileId: 'doc1',
      modo: 'substituir',
      textoAntigo: 'R$ 100',
      textoNovo: 'R$ 120'
    }, { actor: 'owner', fetchImpl });
    assert.equal(res.success, true);
    assert.equal(res.occurrencesChanged, 2);
    assert.equal(capturedBody.requests[0].replaceAllText.replaceText, 'R$ 120');
  } finally {
    if (prevToken === undefined) delete process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
    else process.env.GOOGLE_DRIVE_ACCESS_TOKEN = prevToken;
  }
});

test('Package 2 - log-redaction: mascara chaves de API, Bearer, JWT, PEM e objetos sensíveis', () => {
  const raw = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc1234567890 key=AIzaSyDummyKey1234567890123456789012345 gsk_secret123456789012345678 https://admin:superpass@db.local/app';
  const safe = redactSecrets(raw);
  assert.doesNotMatch(safe, /AIzaSy/);
  assert.doesNotMatch(safe, /gsk_secret/);
  assert.doesNotMatch(safe, /superpass/);
  assert.doesNotMatch(safe, /eyJhbGci/);
  assert.match(safe, /\[REDACTED\]/);

  const obj = redactObject({ apiKey: 'sk-proj-12345678901234567890', safeField: 'ok', nested: { privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' } });
  assert.equal(obj.apiKey, '[REDACTED]');
  assert.equal(obj.safeField, 'ok');
  assert.equal(obj.nested.privateKey, '[REDACTED]');
});

test('Package 2 - event-loop-monitor: detecta e classifica stalls', () => {
  assert.equal(classifyEventLoopStall({ stallMs: 3000, monotonicElapsedMs: 5000, wallElapsedMs: 5000, cpuMs: 2500 }), 'main_thread_cpu');
  assert.equal(classifyEventLoopStall({ stallMs: 3000, monotonicElapsedMs: 5000, wallElapsedMs: 9000, cpuMs: 10 }), 'host_suspended');
  assert.equal(classifyEventLoopStall({ stallMs: 3000, monotonicElapsedMs: 5000, wallElapsedMs: 5000, cpuMs: 50 }), 'blocked_off_cpu');

  let mono = 1000;
  let wall = 1_700_000_000_000;
  let cpuUser = 0;
  const stalls = [];
  const monitor = createEventLoopMonitor({
    intervalMs: 1000,
    thresholdMs: 1500,
    logger: { warn: () => {} },
    onStall: entry => stalls.push(entry),
    probes: {
      monotonicNow: () => mono,
      wallNow: () => wall,
      cpuUsage: () => ({ user: cpuUser, system: 0 }),
      memoryUsage: () => ({ rss: 120 * 1048576, heapUsed: 45 * 1048576 })
    }
  });
  mono += 4000; // 3000ms stall
  wall += 4000;
  cpuUser += 2_600_000; // 2600ms CPU
  const entry = monitor.sample();
  assert.ok(entry);
  assert.equal(entry.stallMs, 3000);
  assert.equal(entry.likelyCause, 'main_thread_cpu');
  assert.equal(stalls.length, 1);
  assert.equal(monitor.getSnapshot().totalStalls, 1);
});

test('Package 2 - safety: remove links inventados/localhost e reescreve rotas conhecidas', () => {
  const res1 = sanitizeInventedLinks('Acesse http://localhost:3000/pix/abc123 ou https://lia.local/teste e https://wa.me/5588999999999', {
    ownOrigin: 'https://liasync.atualyze.com.br'
  });
  assert.match(res1.text, /https:\/\/liasync\.atualyze\.com\.br\/pix\/abc123/);
  assert.doesNotMatch(res1.text, /lia\.local/);
  assert.match(res1.text, /https:\/\/wa\.me\/5588999999999/);
  assert.equal(res1.rewrittenCount, 1);
  assert.equal(res1.removedCount, 1);

  const filtered = filterReply('Veja em https://seu-dominio.com/falso ou https://docs.google.com/document/d/123');
  assert.doesNotMatch(filtered.text, /seu-dominio\.com/);
  assert.match(filtered.text, /docs\.google\.com/);

  const tableReply = filterReply([
    'Componentes:',
    '| Componente | Status | Detalhes |',
    '|---|---|---|',
    '| WhatsApp | Online | Conectado |',
    '| Supabase | Online | 200 |'
  ].join('\n'), { isCopilot: true });
  assert.doesNotMatch(tableReply.text, /\|---\|/);
  assert.match(tableReply.text, /• \*WhatsApp:\* Online - Conectado/);
  assert.match(tableReply.text, /• \*Supabase:\* Online - 200/);
});

test('Package 2 - copilot-tasks: recoverInterruptedOnStartup re-enfileira leitura e marca escrita como incerta', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-recovery-'));
  const filePath = path.join(dir, 'tasks.json');
  const now = Date.now();
  await fs.writeFile(filePath, JSON.stringify([
    {
      id: '11111111-1111-4111-8111-111111111111',
      taskKey: 'k-read',
      ownerKey: 'owner:self',
      targetPhone: '5588999999999',
      requestSummary: 'consultar saúde',
      steps: [{ name: 'consultar_saude_infra', args: { target: 'geral' } }],
      retryPolicy: 'read_only',
      status: 'running',
      attemptCount: 1,
      maxAttempts: 2,
      leaseOwner: 'old-host:1',
      leaseToken: 'tok-1',
      leaseExpiresAt: new Date(now + 120_000).toISOString(),
      createdAt: new Date(now - 5000).toISOString()
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      taskKey: 'k-write',
      ownerKey: 'owner:self',
      targetPhone: '5588999999999',
      requestSummary: 'gerar pix',
      steps: [{ name: 'gerenciar_cobranca_pagamento', args: { valor: 50 } }],
      retryPolicy: 'never',
      status: 'running',
      attemptCount: 1,
      maxAttempts: 1,
      leaseOwner: 'old-host:1',
      leaseToken: 'tok-2',
      leaseExpiresAt: new Date(now + 120_000).toISOString(),
      createdAt: new Date(now - 4000).toISOString()
    }
  ]), 'utf8');

  const store = new CopilotTaskStore({ filePath, allowLocalFallback: true, logger: { warn: () => {}, error: () => {} } });
  await store.load();
  const report = await store.recoverInterruptedOnStartup('new-host:2');
  assert.equal(report.recovered, 2);
  assert.equal(report.requeued, 1);
  assert.equal(report.markedUncertain, 1);

  const tRead = await store.getById('11111111-1111-4111-8111-111111111111', 'owner:self');
  const tWrite = await store.getById('22222222-2222-4222-8222-222222222222', 'owner:self');
  assert.equal(tRead.status, 'queued');
  assert.equal(tRead.errorCode, 'requeued_after_restart');
  assert.equal(tWrite.status, 'uncertain');
  assert.equal(tWrite.errorCode, 'interrupted_by_restart');
  assert.equal(tWrite.notificationStatus, 'pending');
});

test('AI resilience - Groq gpt-oss omite response_format estrito e OpenRouter empty_reply faz retry limpo', async () => {
  const { call } = await import('./ai/call.mjs');
  const { config } = await import('./config.mjs');
  const prevFetch = globalThis.fetch;
  const prevGroq = config.groqKey;
  const prevOr = config.openrouterKey;
  config.groqKey = 'gsk_test_key_1234567890';
  config.openrouterKey = 'sk-or-test-key-1234567890';

  try {
    // 1) Groq gpt-oss: não envia response_format json_object nem no compact retry após 413
    const groqBodies = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      groqBodies.push(body);
      if (groqBodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'Request too large for model' } }), { status: 413 });
      }
      return new Response(JSON.stringify({
        model: 'openai/gpt-oss-20b',
        choices: [{ message: { content: JSON.stringify({ reply: 'Tudo certo!', intent: 'outro', red_flags: false, handoff: false }) } }]
      }), { status: 200 });
    };
    const groqRes = await call('groq', {
      system: 'Responda em JSON.',
      userText: 'Oi',
      fixedModel: 'openai/gpt-oss-20b',
      aiConfig: { provider: 'groq', model: 'openai/gpt-oss-20b' }
    });
    assert.equal(groqBodies.length, 2);
    assert.equal(groqBodies[0].response_format, undefined);
    assert.equal(groqBodies[1].response_format, undefined);
    assert.match(groqRes.raw, /Tudo certo/);

    // 2) OpenRouter: primeiro retorno vem com content vazio -> refaz 1 chamada limpa sem tools/response_format
    const orBodies = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      orBodies.push(body);
      if (orBodies.length === 1) {
        return new Response(JSON.stringify({
          model: 'openrouter/free',
          choices: [{ message: { content: '' } }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        model: 'openrouter/free',
        choices: [{ message: { content: JSON.stringify({ reply: 'Resposta recuperada!', intent: 'outro', red_flags: false, handoff: false }) } }]
      }), { status: 200 });
    };
    const orRes = await call('openrouter', {
      system: 'Responda em JSON.',
      userText: 'Verifica tudo',
      fixedModel: 'openrouter/free',
      aiConfig: { provider: 'openrouter', model: 'openrouter/free' }
    });
    assert.equal(orBodies.length, 2);
    assert.equal(orBodies[1].response_format, undefined);
    assert.equal(orBodies[1].tools, undefined);
    assert.match(orRes.raw, /Resposta recuperada/);
  } finally {
    globalThis.fetch = prevFetch;
    config.groqKey = prevGroq;
    config.openrouterKey = prevOr;
  }
});

test('Autonomia - claimsUnexecutedToolWork bloqueia "Agendado!" falso e owner agenda verificação deterministicamente', async () => {
  const { claimsUnexecutedToolWork } = await import('./flow/copilot-continuity.mjs');
  assert.equal(
    claimsUnexecutedToolWork('Agendado! Daqui a 2 minutos o sistema vai executar automaticamente o diagnóstico completo de saúde das APIs e te devolver o resultado.'),
    true
  );
  assert.equal(claimsUnexecutedToolWork('Não agendei nada porque faltou confirmação.'), false);

  const { createFlow } = await import('./flow.mjs');
  const { SessionStore } = await import('./sessions.mjs');
  const { LiaRuntimeStore, createLiaRuntime } = await import('./runtime/index.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-auto-sched-'));
  const store = new SessionStore(path.join(dir, 'sessions.json'));
  await store.load();
  const rtStore = new LiaRuntimeStore({ filePath: path.join(dir, 'runtime.json'), allowLocalFallback: true, logger: { log: () => {}, warn: () => {}, error: () => {} } });
  const liaRuntime = createLiaRuntime({ store: rtStore, logger: { log: () => {}, warn: () => {}, error: () => {} } });
  await liaRuntime.start();

  let aiCalled = 0;
  const flow = createFlow({
    store,
    liaRuntime,
    getHumanPhone: () => '5588999999999',
    ai: {
      askAI: async () => {
        aiCalled += 1;
        return { reply: 'Agendado fake!', tool_calls: [] };
      }
    }
  });

  const reply = await flow.process({
    phone: '5588999999999',
    text: 'Agenda uma verificação de saúde das apis para daqui a 2 minutos e me avisa o resultado',
    origin: 'whatsapp'
  });

  assert.equal(aiCalled, 0, 'Fast-path determinístico não deve depender da IA para agendar verificação');
  assert.match(reply, /Verificação autônoma agendada no Lia Runtime/i);
  assert.match(reply, /ID:\*? #[0-9A-F]{8}/i, 'Deve exibir o ID real do compromisso');
  assert.match(reply, /\d{2}:\d{2}/, 'Deve exibir o horário real de execução');
  const pending = await liaRuntime.commitments.list({ status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].metadata?.actionTool, 'consultar_saude_infra');

  // Listar e cancelar via linguagem natural
  const listReply = await flow.process({ phone: '5588999999999', text: 'Quais tarefas estão agendadas?', origin: 'whatsapp' });
  assert.match(listReply, /Agendamentos autônomos ativos/i);
  const shortId = pending[0].id.slice(0, 8).toUpperCase();
  const cancelReply = await flow.process({ phone: '5588999999999', text: `cancela #${shortId}`, origin: 'whatsapp' });
  assert.match(cancelReply, /cancelado/i);
  assert.equal((await liaRuntime.commitments.list({ status: 'pending' })).length, 0);
});

test('Package 3 - schedule-parser: horário fixo, rotina recorrente, Gmail/Agenda/Web e auto-reagendamento no Runtime', async () => {
  const { parseAutonomousCommand, computeNextRecurrenceIso } = await import('./runtime/schedule-parser.mjs');
  const baseNow = Date.parse('2026-11-22T11:00:00.000Z'); // 08:00 BRT

  const dailyGmail = parseAutonomousCommand('Todo dia às 8h30 resume meus e-mails não lidos no Gmail', { nowMs: baseNow });
  assert.equal(dailyGmail.kind, 'schedule');
  assert.equal(dailyGmail.actionTool, 'gerenciar_gmail_google');
  assert.equal(dailyGmail.recurrence.kind, 'daily');
  assert.equal(dailyGmail.recurrence.hour, 8);
  assert.equal(dailyGmail.recurrence.minute, 30);

  const weeklyAgenda = parseAutonomousCommand('Toda segunda às 9h verifica minha agenda de hoje', { nowMs: baseNow });
  assert.equal(weeklyAgenda.kind, 'schedule');
  assert.equal(weeklyAgenda.actionTool, 'gerenciar_agenda_google');
  assert.equal(weeklyAgenda.recurrence.kind, 'weekly');
  assert.equal(weeklyAgenda.recurrence.weekday, 1);

  const fixedTomorrow = parseAutonomousCommand('Amanhã às 14:15 verifica a saúde das APIs e me avisa', { nowMs: baseNow });
  assert.equal(fixedTomorrow.kind, 'schedule');
  assert.equal(fixedTomorrow.actionTool, 'consultar_saude_infra');
  assert.equal(fixedTomorrow.recurrence, null);

  const nextRun = computeNextRecurrenceIso({ kind: 'interval_minutes', intervalMinutes: 30 }, baseNow);
  assert.equal(Date.parse(nextRun), baseNow + 30 * 60_000);

  // Runtime re-agenda automaticamente a próxima ocorrência ao executar rotina recorrente
  const { LiaRuntimeStore, createLiaRuntime } = await import('./runtime/index.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-rec-'));
  let fakeNow = baseNow;
  const rtStore = new LiaRuntimeStore({ filePath: path.join(dir, 'rt.json'), allowLocalFallback: true, now: () => fakeNow, logger: { log: () => {}, warn: () => {}, error: () => {} } });
  const notified = [];
  const rt = createLiaRuntime({
    store: rtStore,
    now: () => fakeNow,
    notifyOwner: async msg => notified.push(msg),
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });
  await rt.start();
  await rt.commitments.create({
    title: 'Lembrete recorrente de caixa',
    subject: 'owner',
    dueAt: new Date(baseNow + 60_000).toISOString(),
    metadata: { notifyOwner: true, recurrence: { kind: 'interval_minutes', intervalMinutes: 60 }, recurrenceLabel: 'a cada 1h' }
  });
  fakeNow += 120_000;
  await rt.wake({ reason: 'scheduler' });
  assert.equal(notified.length, 1);
  const nextPending = await rt.commitments.list({ status: 'pending' });
  assert.equal(nextPending.length, 1, 'Rotina recorrente deve criar automaticamente a próxima ocorrência');
  assert.ok(Date.parse(nextPending[0].due_at) > fakeNow);
});

test('Package 4 - Memória Estruturada PARA: classifica, lista com contadores, edita e apaga', async () => {
  const { MemoryStore, classifyParaCategory } = await import('./core/memory.mjs');
  assert.equal(classifyParaCategory({ type: 'project', content: 'Projeto lançamento v4' }), 'project');
  assert.equal(classifyParaCategory({ type: 'preference', content: 'Prefiro respostas curtas' }), 'area');
  assert.equal(classifyParaCategory({ type: 'fact', content: 'Link da documentação de referência' }), 'resource');
  assert.equal(classifyParaCategory({ type: 'fact', content: 'Campanha antiga encerrada em 2025' }), 'archive');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-para-'));
  const ms = new MemoryStore(path.join(dir, 'mem.json'));
  const r1 = ms.remember({ scopeKey: 'default:business', type: 'fact', content: 'Política de entrega: prazo de 24h' });
  const r2 = ms.remember({ scopeKey: 'default:owner', type: 'project', content: 'Projeto expansão clínica norte' });
  const list = ms.listAll();
  assert.equal(list.counts.total, 2);
  assert.equal(list.counts.area, 1);
  assert.equal(list.counts.project, 1);

  const upd = ms.updateById(r1.memory.id, { content: 'Política de entrega: prazo de 48h', category: 'archive' });
  assert.equal(upd.updated, true);
  assert.equal(ms.listAll({ category: 'archive' }).items.length, 1);

  assert.equal(ms.deleteById(r2.memory.id).deleted, true);
  assert.equal(ms.listAll().counts.total, 1);
});

test('Package 5 - Rate-Limit Recovery (Retry-After) e Reações de Progresso no WhatsApp', async () => {
  const { parseRetryAfterMs, opened, getNextProviderRecoveryDelayMs } = await import('./ai/state.mjs');
  assert.equal(parseRetryAfterMs(new Headers({ 'retry-after': '12' }), ''), 12_000);
  assert.equal(parseRetryAfterMs(null, 'Rate limit reached. Please try again in 8.4s.'), 8_400);
  assert.equal(parseRetryAfterMs(null, 'Please try again in 1m15s.'), 75_000);

  const nowMs = Date.now();
  opened.set('groq', nowMs + 9_000);
  opened.set('openrouter', nowMs + 45_000);
  const nextDelay = getNextProviderRecoveryDelayMs(nowMs);
  assert.ok(nextDelay >= 8_500 && nextDelay <= 9_500);
  opened.delete('groq');
  opened.delete('openrouter');

  // Reações de progresso no owner flow
  const { createFlow } = await import('./flow.mjs');
  const { SessionStore } = await import('./sessions.mjs');
  const { LiaRuntimeStore, createLiaRuntime } = await import('./runtime/index.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lia-react-'));
  const store = new SessionStore(path.join(dir, 's.json'));
  await store.load();
  const rtStore = new LiaRuntimeStore({ filePath: path.join(dir, 'r.json'), allowLocalFallback: true, logger: { log: () => {}, warn: () => {}, error: () => {} } });
  const liaRuntime = createLiaRuntime({ store: rtStore, logger: { log: () => {}, warn: () => {}, error: () => {} } });
  await liaRuntime.start();
  const reactions = [];
  const flow = createFlow({
    store,
    liaRuntime,
    getHumanPhone: () => '5588999999999',
    whatsapp: { sendReaction: async (_phone, _key, emoji) => { reactions.push(emoji); return true; } },
    ai: { askAI: async () => ({ reply: 'ok', tool_calls: [] }) }
  });
  await flow.process({
    phone: '5588999999999',
    text: 'Agenda uma verificação de saúde das apis para daqui a 2 minutos',
    origin: 'whatsapp',
    messageId: 'MSG123'
  });
  assert.deepEqual(reactions, ['⏳', '✅']);
});

test('Chat sync - dedupeMessages ordena cronologicamente e remove duplicatas sem ID ou com prefixo wa:', async () => {
  const { dedupeMessages } = await import('./supabase-runtime.mjs');
  const out = dedupeMessages([
    { role: 'assistant', content: 'Resposta 2', createdAt: '2026-11-22T12:00:10.000Z' },
    { role: 'user', content: 'Bom dia', id: 'wa:3EB0910647', createdAt: '2026-11-22T12:00:00.000Z' },
    { role: 'user', content: 'Bom dia', id: '3EB0910647', createdAt: '2026-11-22T12:00:00.000Z' },
    { role: 'assistant', content: 'Resposta 2', createdAt: '2026-11-22T12:00:11.000Z' }
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].content, 'Bom dia');
  assert.equal(out[1].content, 'Resposta 2');
});

test('Instance Isolation - /api/dashboard/state filtra conversas pelo número conectado e permite toggle includeOtherInstances', async () => {
  const { handleDashboardRoutes } = await import('./http/dashboard.mjs');
  const { OWNER_SELF_KEY } = await import('./core/identity.mjs');
  const store = {
    persistence: 'supabase',
    sessions: {
      [OWNER_SELF_KEY]: { phone: OWNER_SELF_KEY, history: [{ role: 'user', content: 'oi', createdAt: '2026-11-22T12:00:00.000Z' }] },
      '5588999990001': { phone: '5588999990001', instancePhone: '558898340085', history: [{ role: 'user', content: 'atual', createdAt: '2026-11-22T12:01:00.000Z' }] },
      '5588999990002': { phone: '5588999990002', instancePhone: '5588921694598', history: [{ role: 'user', content: 'antigo', createdAt: '2026-11-22T12:02:00.000Z' }] }
    }
  };
  const makeRes = () => {
    let body = '';
    return {
      statusCode: 0,
      writeHead(code) { this.statusCode = code; },
      end(chunk) { body = String(chunk || ''); },
      json() { return JSON.parse(body); }
    };
  };

  const resFiltered = makeRes();
  await handleDashboardRoutes({
    req: { method: 'GET' },
    res: resFiltered,
    u: new URL('http://localhost/api/dashboard/state?mode=real'),
    store,
    f: null,
    getActiveInstancePhone: () => '558898340085'
  });
  const dataFiltered = resFiltered.json();
  assert.equal(dataFiltered.otherInstancesCount, 1);
  assert.equal(dataFiltered.sessions.some(s => s.phone === '5588999990001'), true);
  assert.equal(dataFiltered.sessions.some(s => s.phone === '5588999990002'), false);
  assert.equal(dataFiltered.sessions.some(s => s.phone === OWNER_SELF_KEY), true);

  const resAll = makeRes();
  await handleDashboardRoutes({
    req: { method: 'GET' },
    res: resAll,
    u: new URL('http://localhost/api/dashboard/state?mode=real&includeOtherInstances=1'),
    store,
    f: null,
    getActiveInstancePhone: () => '558898340085'
  });
  const dataAll = resAll.json();
  assert.equal(dataAll.sessions.some(s => s.phone === '5588999990002'), true);
});

test('Google OAuth2 (estilo n8n) - gera authUrl com escopos escolhidos, valida state de uso único e troca code', async () => {
  const { buildGoogleOAuthStart, consumeGoogleOAuthState, exchangeGoogleOAuthCode } = await import('./tools/google_oauth.mjs');
  const started = buildGoogleOAuthStart({
    selectedIds: ['calendar', 'gmail'],
    redirectUri: 'https://liasync.atualyze.com.br/api/oauth/google/callback',
    clientId: 'cid-123',
    clientSecret: 'csec-456'
  });
  assert.match(started.authUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(started.authUrl, /access_type=offline/);
  assert.match(started.authUrl, /calendar/);
  assert.match(started.authUrl, /gmail\.compose/);

  const consumed = consumeGoogleOAuthState(started.state);
  assert.ok(consumed);
  assert.deepEqual(consumed.selectedIds, ['calendar', 'gmail']);
  // Single-use: segunda chamada com mesmo state deve retornar null
  assert.equal(consumeGoogleOAuthState(started.state), null);

  const tokens = await exchangeGoogleOAuthCode({
    code: 'auth-code-xyz',
    redirectUri: started.redirectUri,
    clientId: 'cid-123',
    clientSecret: 'csec-456',
    fetchImpl: async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-999', scope: 'openid email' }), { status: 200 });
      }
      return new Response(JSON.stringify({ email: 'tauan@atualyze.com.br' }), { status: 200 });
    }
  });
  assert.equal(tokens.refreshToken, 'rt-999');
  assert.equal(tokens.email, 'tauan@atualyze.com.br');
});

test('Auto-registro de Leads no Google Sheets - grava na aba Leads!A:G, deduplica 6h e ignora simulação/dono', async () => {
  const { syncLeadToGoogleSheet } = await import('./tools/sheets_lead_sync.mjs');
  const { config } = await import('./config.mjs');
  const prevSheet = config.googleSheetsDefaultId;
  config.googleSheetsDefaultId = 'sheet-demo-123';
  try {
    const appended = [];
    const executeAppend = async (args) => {
      appended.push(args);
      return { success: true, updatedRange: 'Leads!A2:G2' };
    };
    const session = { phone: '5588999991234', clientName: 'Carlos', origin: 'real', contextSummary: 'Automação WhatsApp' };
    const r1 = await syncLeadToGoogleSheet({ session, stage: 'Agendado', interest: 'Diagnóstico 30 min', executeAppend });
    assert.equal(r1.synced, true);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].range, 'Leads!A:G');
    assert.equal(appended[0].valores[1], 'Carlos');
    assert.equal(appended[0].valores[4], 'Agendado');

    // Deduplicação: mesmo estágio + interesse na janela de 6h não duplica
    const r2 = await syncLeadToGoogleSheet({ session, stage: 'Agendado', interest: 'Diagnóstico 30 min', executeAppend });
    assert.equal(r2.synced, false);
    assert.equal(r2.reason, 'deduped');
    assert.equal(appended.length, 1);

    // Simulação nunca grava na planilha real
    const simRes = await syncLeadToGoogleSheet({ session: { phone: 'sim:5588999991234', origin: 'simulation' }, stage: 'Qualificado', executeAppend });
    assert.equal(simRes.synced, false);
    assert.equal(simRes.reason, 'non_client_session');
  } finally {
    config.googleSheetsDefaultId = prevSheet;
  }
});
