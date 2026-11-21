import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { LiaRuntimeStore, createLiaRuntime } from '../runtime/index.mjs';
import { LiaLearningStore, createLearningEngine } from '../learning/index.mjs';
import {
  createAutonomyEngine,
  prioritizeGoalsAntiStarvation,
  planRecovery,
  evaluateSystemHealth
} from './index.mjs';
import { CopilotTaskStore } from '../copilot-tasks.mjs';
import { createCopilotTaskWorker } from '../copilot-task-worker.mjs';
import { createApp } from '../server.mjs';
import { SessionStore } from '../sessions.mjs';
import { AdminConfigStore } from '../admin-config.mjs';

const silentLogger = { info() {}, warn() {}, error() {} };

// === 1. Autonomia E2E: Objetivo -> Evento -> Runtime -> copilot_tasks -> Worker -> Verificação ===
test('E2E Autonomia: objetivo + evento acorda Runtime, cria task em copilot_tasks, executa e registra auditoria', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-e2e-auto-'));
  try {
    const rtStore = new LiaRuntimeStore({ filePath: path.join(dir, 'runtime.json'), logger: silentLogger });
    const learnStore = new LiaLearningStore({ filePath: path.join(dir, 'learning.json'), logger: silentLogger });
    const taskStore = new CopilotTaskStore({ filePath: path.join(dir, 'tasks.json'), logger: silentLogger });
    await taskStore.load();

    const learning = createLearningEngine({ store: learnStore, reflectionCooldownMs: 0, logger: silentLogger });
    await learning.start();
    const runtime = createLiaRuntime({ store: rtStore, taskStore, learningEngine: learning, getHumanPhone: () => '5588999999999', logger: silentLogger });
    await runtime.start();
    const autonomy = createAutonomyEngine({ runtime, learning, taskStore, logger: silentLogger });

    const goal = await runtime.goals.create({ title: 'Garantir estabilidade operacional', indicator: 'uptime', priority: 'high', status: 'active' });
    await runtime.emitEvent({
      type: 'system.health_change',
      source: 'monitor',
      subject: 'vps-main',
      priority: 'high',
      deduplicationKey: 'health:vps-main:1',
      payload: { healthy: false, target: 'geral', goal_id: goal.id }
    });

    const wakeRes = await runtime.wake({ reason: 'event' });
    assert.equal(wakeRes.tasksCreated, 1);

    const sent = [];
    const worker = createCopilotTaskWorker({
      taskStore,
      store: { get: () => ({ history: [] }), markDirty() {}, flush: async () => {} },
      ai: { askAI: async () => ({ reply: 'Diagnóstico concluído: VPS saudável.' }) },
      sendText: async (_t, msg) => sent.push(msg),
      broadcastBridgeEvent: () => {},
      getHumanPhone: () => '5588999999999',
      logger: silentLogger,
      execute: async () => ({ success: true, health: 'healthy', checks: [{ name: 'vps', status: 'ok' }] })
    });
    const cycles = await worker.drain({ maxCycles: 4 });
    assert.equal(cycles, 2);
    assert.equal(sent.length, 1);

    const dec = await autonomy.decideAndAct({
      why: 'Validar resultado do diagnóstico',
      goal,
      proposedAction: 'analyze',
      expectedOutcome: 'diagnóstico confirmado',
      execute: async () => ({ confirmed: true, health: 'healthy' })
    });
    assert.equal(dec.executed, true);
    assert.equal(dec.verification.status, 'confirmed');
    assert.equal(autonomy.getAuditTrail().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 2. Proatividade: Compromisso vence + Deduplicação + Daily Review ===
test('E2E Proatividade: compromisso vencendo gera evento, comunicação deduplica e revisão vazia dorme em silêncio', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-e2e-proact-'));
  try {
    let clock = Date.parse('2026-11-21T09:00:00Z');
    const rtStore = new LiaRuntimeStore({ filePath: path.join(dir, 'runtime.json'), logger: silentLogger, now: () => clock });
    const runtime = createLiaRuntime({ store: rtStore, logger: silentLogger, now: () => clock });
    await runtime.start();

    const proactiveSent = [];
    const autonomy = createAutonomyEngine({
      runtime,
      notifyProactive: async item => proactiveSent.push(item),
      logger: silentLogger,
      now: () => clock
    });

    // Revisão sem pendências não envia mensagem artificial
    const emptyReview = await autonomy.runDailyReview();
    assert.equal(emptyReview.notified, false);
    assert.equal(proactiveSent.length, 0);

    // Cria compromisso e avança o relógio para vencê-lo
    await runtime.commitments.create({
      title: 'Retornar orçamento ao João',
      subject: '5511999998888',
      dueAt: '2026-11-22T09:00:00Z'
    });
    clock = Date.parse('2026-11-22T09:05:00Z');
    const wakeRes = await runtime.wake({ reason: 'scheduler' });
    assert.equal(wakeRes.dueCommitments, 1);

    // Comunicação proativa envia 1x e bloqueia duplicata consecutiva
    const c1 = await autonomy.communicateProactively({
      reason: 'commitment_due',
      deduplicationKey: 'comm:joao:1',
      subject: 'owner',
      message: 'Compromisso vencendo: Retornar orçamento ao João.'
    });
    const c2 = await autonomy.communicateProactively({
      reason: 'commitment_due',
      deduplicationKey: 'comm:joao:1',
      subject: 'owner',
      message: 'Compromisso vencendo: Retornar orçamento ao João.'
    });
    assert.equal(c1.sent, true);
    assert.equal(c2.sent, false);
    assert.equal(c2.reason, 'duplicate_proactive_message');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 3. Fluxo E2E 1 — Sales Autônomo (Objetivo -> Lead -> Score -> Outbound Autorizado -> Resposta -> Qualificação -> Aprendizado) ===
test('E2E Sales: ciclo comercial completo do objetivo ao aprendizado e atualização de estratégia', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-e2e-sales-'));
  try {
    const rtStore = new LiaRuntimeStore({ filePath: path.join(dir, 'runtime.json'), logger: silentLogger });
    const learnStore = new LiaLearningStore({ filePath: path.join(dir, 'learning.json'), logger: silentLogger });
    const learning = createLearningEngine({ store: learnStore, reflectionCooldownMs: 0, logger: silentLogger });
    await learning.start();
    const runtime = createLiaRuntime({ store: rtStore, learningEngine: learning, logger: silentLogger });
    await runtime.start();

    const autonomy = createAutonomyEngine({ runtime, learning, logger: silentLogger });
    autonomy.setOrgPolicy('org_alpha', {
      autonomy_level: 'supervised_autonomous',
      allowed_actions: ['follow_up', 'commercial_message', 'crm_update']
    });

    const goal = await runtime.goals.create({ title: 'Aumentar oportunidades comerciais', indicator: 'qualified_leads', priority: 'high', status: 'active' });

    // 1. Scoring baseado em fatores reais
    const leadState = autonomy.sales.evaluateLead({
      subject: '5511988881111',
      tenantId: 'org_alpha',
      factors: { icpFit: 0.92, intent: 0.85, engagement: 0.90, problem: 0.80, urgency: 0.78, capacity: 0.80, history: 0.70 }
    });
    assert.ok(leadState.score >= 80);

    // 2. Personalização estritamente factual
    const personalization = autonomy.buildGroundedPersonalization({
      contactName: 'Maria',
      companyName: 'Clínica Vida',
      segment: 'clinicas',
      verifiedProblem: 'demora no agendamento pelo WhatsApp'
    });
    assert.match(personalization.draftMessage, /Maria/);
    assert.match(personalization.draftMessage, /demora no agendamento/);

    // 3. Outbound autorizado pela política da organização
    const outboundRes = await autonomy.decideAndAct({
      tenantId: 'org_alpha',
      why: 'Lead qualificado com score >= 80',
      goal,
      proposedAction: 'commercial_message',
      expectedOutcome: 'mensagem enviada e resposta do prospect',
      targetPhone: '5511988881111',
      effectType: 'outbound',
      execute: async () => ({ confirmed: true, messageId: 'wamid-1' })
    });
    assert.equal(outboundRes.executed, true);
    autonomy.sales.transition({ subject: '5511988881111', tenantId: 'org_alpha', toStage: 'contacted', evidence: 'wamid-1' });

    // 4. Resposta positiva -> cadência adaptativa -> qualificação + relacionamento
    const nextStep = autonomy.decideNextCadenceStep({ signal: 'positive_reply', attempts: 1 });
    assert.equal(nextStep.action, 'accelerate_qualification');
    autonomy.sales.transition({ subject: '5511988881111', tenantId: 'org_alpha', toStage: 'engaged', evidence: 'prospect_replied_yes' });
    autonomy.sales.transition({ subject: '5511988881111', tenantId: 'org_alpha', toStage: 'qualified', evidence: 'confirmed_need_and_budget' });
    await learning.relationships.update('5511988881111', { commercial_stage: 'qualified', interests: ['automação'] }, 'org_alpha');

    const situation = await autonomy.relationships.getSituation('5511988881111', 'org_alpha');
    assert.equal(situation.commercial_stage, 'qualified');

    // 5. Ciclo de aprendizado registra experiência e gera estratégia versionada
    await learning.runLearningCycle({ maxBatch: 5 });
    const strat = await learning.strategies.createVersion({
      strategyKey: 'sales_clinics',
      scope: 'segment',
      confidence: 0.85,
      definition: { opener: 'verified_problem' }
    });
    await learning.strategies.activate(strat.id, { reply_rate: 1.0 });

    const metrics = autonomy.getMetrics();
    assert.equal(metrics.sales.leads_contacted, 1);
    assert.equal(metrics.sales.qualified, 1);
    assert.equal(metrics.sales.qualification_rate, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 4. Fluxo E2E 2 — Atendimento Autônomo orientado a resultado ===
test('E2E Support: diferencia envio de resolução confirmada, cria follow-up quando parcial e encerra quando confirmado', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-e2e-support-'));
  try {
    const rtStore = new LiaRuntimeStore({ filePath: path.join(dir, 'runtime.json'), logger: silentLogger });
    const learnStore = new LiaLearningStore({ filePath: path.join(dir, 'learning.json'), logger: silentLogger });
    const learning = createLearningEngine({ store: learnStore, logger: silentLogger });
    await learning.start();
    const runtime = createLiaRuntime({ store: rtStore, learningEngine: learning, logger: silentLogger });
    await runtime.start();
    const autonomy = createAutonomyEngine({ runtime, learning, logger: silentLogger });

    // Caso 1: resposta enviada, mas cliente ainda não confirmou -> NÃO encerra e cria compromisso de verificação
    const partialCase = await autonomy.support.handleCase({
      subject: '5511977772222',
      problemDescription: 'Erro ao sincronizar webhook',
      observedConfirmation: null
    });
    assert.equal(partialCase.closed, false);
    assert.equal(partialCase.verificationStatus, 'partial');
    assert.ok(partialCase.followUpCommitment);

    // Caso 2: cliente confirmou resolução -> encerra e registra sucesso
    const resolvedCase = await autonomy.support.handleCase({
      subject: '5511977773333',
      problemDescription: 'Dúvida na configuração de expediente',
      observedConfirmation: { resolved: true }
    });
    assert.equal(resolvedCase.closed, true);
    assert.equal(resolvedCase.verificationStatus, 'confirmed');
    assert.equal(resolvedCase.followUpCommitment, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 5. Safety, Multi-Tenancy, Conflict Resolution, Failure Recovery & Anti-Starvation ===
test('E2E Safety & Recovery: bloqueia Pix/outbound não autorizado/opt-out/uncertain/Categoria D e prioriza anti-starvation', async () => {
  const suppressed = new Set(['5511900009999']);
  const autonomy = createAutonomyEngine({
    isSuppressed: async phone => suppressed.has(phone),
    logger: silentLogger
  });

  // Pix sem confirmação -> bloqueado
  const pix = await autonomy.decideAndAct({ proposedAction: 'pix_charge', risk: 'high' });
  assert.equal(pix.executed, false);
  assert.equal(pix.authorization.decision, 'requires_confirmation');

  // Outbound sem pré-autorização na organização -> bloqueado
  const outNoAuth = await autonomy.decideAndAct({ tenantId: 'org_strict', proposedAction: 'follow_up', targetPhone: '5511988880000' });
  assert.equal(outNoAuth.executed, false);
  assert.equal(outNoAuth.authorization.decision, 'requires_authorization');

  // Mesmo com pré-autorização, suppression e opt-out bloqueiam
  autonomy.setOrgPolicy('org_open', { autonomy_level: 'supervised_autonomous', allowed_actions: ['follow_up'] });
  const outSuppressed = await autonomy.decideAndAct({ tenantId: 'org_open', proposedAction: 'follow_up', targetPhone: '5511900009999' });
  assert.equal(outSuppressed.authorization.decision, 'blocked_suppressed');

  const outOptOut = await autonomy.decideAndAct({ tenantId: 'org_open', proposedAction: 'follow_up', targetPhone: '5511988880001', optOut: true });
  assert.equal(outOptOut.authorization.decision, 'blocked_opt_out');

  // Categoria D proibida
  const forbidden = await autonomy.decideAndAct({ proposedAction: 'self_elevate_permissions', explicitConfirmation: true });
  assert.equal(forbidden.executed, false);
  assert.equal(forbidden.authorization.decision, 'forbidden');

  // Uncertain nunca gera retry automático
  const recUncertain = planRecovery({ errorCode: 'delivery_uncertain', effectType: 'outbound' });
  assert.equal(recUncertain.retryAllowed, false);
  assert.equal(recUncertain.action, 'escalate_human');

  // Provider sem créditos pausa LLM sem loop
  const recCredits = planRecovery({ errorCode: 'AI_PROVIDER_CREDITS_EXHAUSTED', effectType: 'read_only' });
  assert.equal(recCredits.retryAllowed, false);
  assert.equal(recCredits.action, 'pause_llm_actions');

  // Conflito contextual: "sim" diante de estado uncertain exige esclarecimento
  const conflict = autonomy.resolveContextualConflict({
    message: 'sim',
    contexts: [
      { id: 'pix-1', kind: 'pix', state: 'pending', risk: 'high', relevance: 80 },
      { id: 'out-1', kind: 'outbound', state: 'uncertain', risk: 'high', relevance: 90 }
    ]
  });
  assert.equal(conflict.resolution, 'clarify');

  // Anti-starvation: objetivo de baixa prioridade esquecido há 48h ganha boost relevante
  const nowMs = Date.parse('2026-11-21T12:00:00Z');
  const ordered = prioritizeGoalsAntiStarvation([
    { id: 'g-med', status: 'active', priority: 'medium', updated_at: '2026-11-21T11:55:00Z' },
    { id: 'g-low-old', status: 'active', priority: 'low', updated_at: '2026-11-19T12:00:00Z' }
  ], nowMs);
  assert.equal(ordered[0].goal.id, 'g-low-old');

  const health = evaluateSystemHealth({ aiCreditsPaused: true, uncertainTasks: 1 });
  assert.equal(health.healthy, false);
  assert.equal(health.alerts.length, 2);
});

// === 6. HTTP /health e /ready integrados com Runtime + Learning + Autonomy ===
test('E2E Readiness: /ready inclui copilot_tasks, lia_runtime, lia_learning e lia_autonomy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-e2e-ready-'));
  try {
    const store = new SessionStore(path.join(dir, 'sessions.json'));
    const adminConfig = new AdminConfigStore(path.join(dir, 'admin-config.json'));
    const app = await createApp({
      store,
      adminConfig,
      readinessCheck: async () => ({ ok: true, status: 'ready', checks: [{ name: 'ai', status: 'ready' }] }),
      dashboardAuth: async () => ({ ok: true, role: 'admin' })
    });

    let statusCode = 0;
    let body = '';
    const res = {
      writeHead(code) { statusCode = code; },
      end(chunk) { body = String(chunk || ''); }
    };
    await app({ method: 'GET', url: '/ready', headers: {} }, res);
    assert.equal(statusCode, 200);
    const parsed = JSON.parse(body);
    assert.equal(parsed.status, 'ready');
    const names = parsed.checks.map(c => c.name);
    assert.ok(names.includes('copilot_tasks'));
    assert.ok(names.includes('lia_runtime'));
    assert.ok(names.includes('lia_learning'));
    assert.ok(names.includes('lia_autonomy'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
