import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { LiaLearningStore, createLearningEngine, evaluateExperiment } from './index.mjs';
import { LiaRuntimeStore, createLiaRuntime } from '../runtime/index.mjs';

const silentLogger = { info() {}, warn() {}, error() {} };

// === 1. Experience ===
test('Learning Experience: registro, deduplicação, sucesso, falha, uncertain e sanitização', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-learn-exp-'));
  try {
    const store = new LiaLearningStore({ filePath: path.join(dir, 'learning.json'), logger: silentLogger });
    const engine = createLearningEngine({ store, logger: silentLogger });
    await engine.start();

    const ok1 = await engine.experiences.record({
      deduplicationKey: 'exp:1',
      action: 'abordagem_a',
      outcome: 'success',
      significance: 'high',
      context: { api_key: 'sk-secret-12345678901234', leadScore: 88 }
    });
    const dup = await engine.experiences.record({
      deduplicationKey: 'exp:1',
      action: 'abordagem_a',
      outcome: 'success',
      significance: 'high'
    });
    assert.equal(ok1.recorded, true);
    assert.equal(ok1.created, true);
    assert.equal(dup.created, false);
    assert.equal(ok1.experience.context.api_key, undefined);
    assert.equal(ok1.experience.context.leadScore, 88);

    const fail = await engine.experiences.record({
      action: 'followup_24h',
      outcome: 'failure',
      error: 'prospect_rejected'
    });
    assert.equal(fail.experience.outcome, 'failure');

    const unc = await engine.experiences.record({
      action: 'gerenciar_cobranca_pagamento',
      outcome: 'uncertain'
    });
    assert.equal(unc.experience.outcome, 'uncertain');
    assert.equal(unc.experience.significance, 'high');

    const ignored = await engine.experiences.record({
      action: 'noop',
      outcome: 'success',
      significance: 'low',
      irrelevant: true
    });
    assert.equal(ignored.recorded, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 2. Reflection & AI Credit Exhaustion Safety ===
test('Learning Reflection: reflete erro/sucesso significativo, ignora irrelevante e não faz loop sem créditos de IA', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-learn-ref-'));
  try {
    let aiCalls = 0;
    const store = new LiaLearningStore({ filePath: path.join(dir, 'learning.json'), logger: silentLogger });
    const engine = createLearningEngine({
      store,
      reflectionCooldownMs: 0,
      ai: {
        askAI: async () => {
          aiCalls += 1;
          return { provider_error: 'AI_PROVIDER_CREDITS_EXHAUSTED', reply: '' };
        }
      },
      logger: silentLogger
    });
    await engine.start();

    const failExp = await engine.experiences.record({
      action: 'abordagem_comercial_a',
      outcome: 'failure',
      significance: 'high',
      error: 'sem_interesse'
    });
    const ref1 = await engine.reflectOnExperience(failExp.experience.id);
    assert.equal(ref1.reflected, true);
    assert.equal(ref1.reflection.ai_fallback_reason, 'AI_PROVIDER_CREDITS_EXHAUSTED');
    assert.equal(engine.aiCreditsPaused, true);
    assert.ok(ref1.learned);
    assert.equal(ref1.learned.status, 'candidate'); // Nunca vira regra consolidada imediatamente

    const okExp = await engine.experiences.record({
      action: 'abordagem_comercial_b',
      outcome: 'success',
      significance: 'high'
    });
    const ref2 = await engine.reflectOnExperience(okExp.experience.id);
    assert.equal(ref2.reflected, true);
    assert.equal(aiCalls, 1, 'não deve repetir chamadas de IA após AI_PROVIDER_CREDITS_EXHAUSTED');

    const lowExp = await engine.experiences.record({
      action: 'ping_rotina',
      eventType: 'task.completed',
      outcome: 'success',
      significance: 'low'
    });
    const refLow = await engine.reflectOnExperience(lowExp.experience.id);
    assert.equal(refLow.reflected, false);
    assert.equal(refLow.reason, 'not_significant_enough');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 3. Knowledge, Scopes, Unlearning, Conflicts & Relationships ===
test('Learning Knowledge: escopo, confiança, desaprendizado com histórico, conflito e relacionamento', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-learn-know-'));
  try {
    const store = new LiaLearningStore({ filePath: path.join(dir, 'learning.json'), logger: silentLogger });
    const engine = createLearningEngine({ store, logger: silentLogger });
    await engine.start();

    const pref = await engine.knowledge.create({
      kind: 'preference',
      scope: 'individual',
      subject: 'joao',
      content: 'João prefere contato depois das 14h.'
    });
    await assert.rejects(
      () => engine.knowledge.updateScope(pref.id, 'global'),
      /individual_preference_cannot_promote_to_global/
    );

    let strat = await engine.knowledge.create({
      kind: 'strategy',
      scope: 'segment',
      topic: 'clinicas',
      content: 'Começar pela dor operacional aumenta resposta.',
      confidence: 0.55
    });
    for (let i = 0; i < 6; i++) {
      strat = await engine.knowledge.recordEvidence(strat.id, { positive: true, weight: 1.5, reason: 'resposta_positiva' });
    }
    assert.ok(strat.confidence > 0.8);
    assert.equal(strat.status, 'supported');

    // Desaprendizado após evidências negativas preserva histórico
    for (let i = 0; i < 4; i++) {
      strat = await engine.knowledge.recordEvidence(strat.id, { positive: false, weight: 1.5, reason: 'rejeicao' });
    }
    assert.ok(strat.confidence < 0.4);
    assert.ok(['deprecated', 'contradicted'].includes(strat.status));
    assert.ok(strat.history.length >= 11);

    // Resolução de conflito prioriza evidência/confiança, não "última memória vence"
    const strong = await engine.knowledge.create({ kind: 'strategy', scope: 'segment', content: 'Estratégia validada', confidence: 0.65 });
    let strongUpdated = strong;
    for (let i = 0; i < 6; i++) strongUpdated = await engine.knowledge.recordEvidence(strongUpdated.id, { positive: true, weight: 1.5 });
    const weakRecent = await engine.knowledge.create({ kind: 'strategy', scope: 'global', content: 'Inferência recente fraca', confidence: 0.45 });
    const resolution = engine.knowledge.resolveConflict(strongUpdated, weakRecent);
    assert.equal(resolution.winner.id, strongUpdated.id);

    // Relationship Learning
    const rel = await engine.relationships.update('5511999998888', {
      preferences: { style: 'curto' },
      best_hours: ['14h-17h'],
      interests: ['produto X'],
      objections: ['preço'],
      commercial_stage: 'proposta'
    });
    assert.equal(rel.preferences.style, 'curto');
    assert.deepEqual(rel.best_hours, ['14h-17h']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 4 & 5. Hypothesis & Safe Experiments ===
test('Learning Hypothesis & Experiments: limites, sucesso objetivo, rollback automático e guards de segurança', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-learn-exp-engine-'));
  try {
    const suppressedPhones = new Set(['5511900001111']);
    const store = new LiaLearningStore({ filePath: path.join(dir, 'learning.json'), logger: silentLogger });
    const engine = createLearningEngine({
      store,
      isSuppressed: async phone => suppressedPhones.has(phone),
      logger: silentLogger
    });
    await engine.start();

    const hyp = await engine.hypotheses.create({
      statement: 'Follow-up após 48h gera mais respostas que após 24h.',
      scope: 'segment',
      metric: 'reply_rate'
    });
    assert.equal(hyp.status, 'candidate');

    // Experimento válido com amostra limitada a 8
    const exp = await engine.experiments.create({
      hypothesisId: hyp.id,
      metric: 'reply_rate',
      population: 'clinics',
      control: { timingHours: 24 },
      variant: { timingHours: 48 },
      sampleLimit: 8,
      riskLimit: 0.15,
      successThreshold: 0.1
    });

    // Contato em suppression ou opt-out é bloqueado
    const blockedSuppressed = await engine.experiments.recordSample(exp.id, { arm: 'variant', phone: '5511900001111', success: true });
    assert.equal(blockedSuppressed.accepted, false);
    assert.equal(blockedSuppressed.reason, 'recipient_suppressed');

    const blockedOptOut = await engine.experiments.recordSample(exp.id, { arm: 'variant', optOut: true, success: true });
    assert.equal(blockedOptOut.accepted, false);
    assert.equal(blockedOptOut.reason, 'recipient_opted_out');

    const blockedOutbound = await engine.experiments.recordSample(exp.id, { arm: 'variant', outboundAllowed: false, success: true });
    assert.equal(blockedOutbound.accepted, false);
    assert.equal(blockedOutbound.reason, 'outbound_guard_blocked');

    // 4 amostras control (1 sucesso = 25%) e 4 amostras variant (3 sucessos = 75%)
    for (let i = 0; i < 4; i++) await engine.experiments.recordSample(exp.id, { arm: 'control', success: i === 0 });
    let last;
    for (let i = 0; i < 4; i++) last = await engine.experiments.recordSample(exp.id, { arm: 'variant', success: i < 3 });

    assert.equal(last.completed, true);
    assert.equal(last.experiment.status, 'completed');
    const evaluation = await engine.finalizeExperimentEvaluation(exp.id);
    assert.equal(evaluation.winner, 'variant');
    assert.ok(evaluation.relativeLiftPct > 100);

    const updatedHyp = await engine.hypotheses.get(hyp.id);
    assert.ok(updatedHyp.confidence > hyp.confidence);

    // Experimento com taxa de reclamação alta sofre rollback automático
    const risky = await engine.experiments.create({
      metric: 'reply_rate',
      population: 'test_rollback',
      control: { style: 'a' },
      variant: { style: 'b' },
      sampleLimit: 20,
      riskLimit: 0.1,
      rollbackCondition: { maxComplaintRate: 0.1 }
    });
    await engine.experiments.recordSample(risky.id, { arm: 'variant', complaint: true });
    const rb = await engine.experiments.recordSample(risky.id, { arm: 'variant', complaint: true });
    assert.equal(rb.rolledBack, true);
    assert.equal(rb.experiment.status, 'rolled_back');

    // Experimento envolvendo Pix ou bypass é rejeitado na criação
    await assert.rejects(
      () => engine.experiments.create({ metric: 'pix_conversion', involvesPix: true, variant: { gerenciar_cobranca_pagamento: true } }),
      /experiment_violates_safety_policy/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 6. Strategy Registry ===
test('Learning Strategy: versionamento, ativação, desativação e seleção por escopo', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-learn-strat-'));
  try {
    const store = new LiaLearningStore({ filePath: path.join(dir, 'learning.json'), logger: silentLogger });
    const engine = createLearningEngine({ store, logger: silentLogger });
    await engine.start();

    const v1 = await engine.strategies.createVersion({
      strategyKey: 'sales_followup',
      scope: 'segment',
      confidence: 0.72,
      definition: { steps: ['reconhecer_contexto', 'propor_proximo_passo'] }
    });
    const v2 = await engine.strategies.createVersion({
      strategyKey: 'sales_followup',
      scope: 'segment',
      confidence: 0.88,
      definition: { steps: ['reconhecer_contexto', 'confirmar_necessidade', 'propor_proximo_passo'] }
    });
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);

    await engine.strategies.activate(v1.id);
    await engine.strategies.activate(v2.id, { reply_rate: 0.17 });

    const v1After = await engine.strategies.get(v1.id);
    assert.equal(v1After.status, 'deprecated');

    const best = await engine.strategies.selectBest({ strategyKey: 'sales_followup', scope: 'segment' });
    assert.equal(best.id, v2.id);

    await engine.strategies.disable(v2.id);
    assert.equal(await engine.strategies.selectBest({ strategyKey: 'sales_followup', scope: 'segment' }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 7, 8 & 9. Learning Loop + Safety Boundary + Regression Knowledge + Runtime Integration ===
test('Learning Safety, Regression Knowledge e integração com LiaRuntime', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-learn-safe-'));
  try {
    const learnStore = new LiaLearningStore({ filePath: path.join(dir, 'learning.json'), logger: silentLogger });
    const learning = createLearningEngine({ store: learnStore, reflectionCooldownMs: 0, logger: silentLogger });
    await learning.start();

    // Fronteira de segurança: código e permissões são bloqueados e viram improvement_proposal
    const deniedCode = await learning.requestSelfImprovement('production_code_modification', {
      summary: 'Alterar src/flow/owner.mjs automaticamente'
    });
    assert.equal(deniedCode.allowed, false);
    assert.equal(deniedCode.proposal.status, 'pending_human_review');

    const deniedPerm = await learning.requestSelfImprovement('permission_escalation', {
      summary: 'Habilitar envio sem confirmação'
    });
    assert.equal(deniedPerm.allowed, false);
    assert.equal((await learning.listProposals()).length, 2);

    const allowedStrat = await learning.requestSelfImprovement('strategy_update', {
      summary: 'Ajustar ordem de perguntas de qualificação'
    });
    assert.equal(allowedStrat.allowed, true);

    // Regression Knowledge alimenta specs de testes futuros
    await learning.regressions.register({
      problemPattern: '"sim" após despacho incerto',
      expectedBehavior: 'não autorizar automaticamente o despacho',
      forbiddenBehavior: 'interpretar como autorização',
      testReference: 'src/flow/owner-outbound-uncertain.test.mjs'
    });
    const specs = await learning.regressions.exportTestSpecs();
    assert.equal(specs.length, 1);
    assert.equal(specs[0].testRef, 'src/flow/owner-outbound-uncertain.test.mjs');

    // Integração com LiaRuntime: task.uncertain registra experiência, reflete com bloqueio e não cria replay
    const rtStore = new LiaRuntimeStore({ filePath: path.join(dir, 'runtime.json'), logger: silentLogger });
    const runtime = createLiaRuntime({ store: rtStore, learningEngine: learning, logger: silentLogger });
    await runtime.start();

    await runtime.emitEvent({
      type: 'task.uncertain',
      source: 'copilot_worker',
      subject: 'task-99',
      priority: 'critical',
      deduplicationKey: 'rt:uncertain:99',
      payload: { task_id: 'task-99' }
    });
    const wakeSummary = await runtime.wake({ reason: 'test' });
    assert.equal(wakeSummary.tasksCreated, 0);

    const recorded = await learning.experiences.list({ outcome: 'uncertain' });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].reflected, true);
    assert.equal((await learning.knowledge.list()).length, 0, 'uncertain não cria regra/estratégia automática de replay');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
