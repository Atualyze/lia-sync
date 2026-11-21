import crypto from 'node:crypto';
import { LiaLearningStore } from './store.mjs';
import { ExperienceStore, FeedbackEngine } from './experience.mjs';
import { KnowledgeStore, RelationshipLearningStore, RegressionKnowledgeStore } from './knowledge.mjs';
import { HypothesisEngine, StrategyRegistry, ExperimentEngine, evaluateExperiment } from './experiments.mjs';
import { enforceSelfImprovementBoundary, sanitizeLearningData, sanitizeLearningString } from './boundary.mjs';

const DEFAULT_REFLECTION_COOLDOWN_MS = 10_000;
const DEFAULT_REFLECTION_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_REFLECTIONS_PER_WINDOW = 30;

export function shouldReflectOnExperience(experience, feedbackSummary) {
  if (!experience || experience.reflected) return false;
  if (experience.outcome === 'failure' || experience.outcome === 'uncertain') return true;
  if (experience.significance === 'high' || experience.significance === 'critical') return true;
  if (feedbackSummary?.hasExplicitHuman) return true;
  if (experience.significance === 'low' && experience.outcome === 'success' && (!feedbackSummary || feedbackSummary.count === 0)) {
    return false;
  }
  return false;
}

export function buildDeterministicReflection(experience, feedbackSummary) {
  const isFailure = experience.outcome === 'failure' || experience.outcome === 'uncertain';
  const isUncertain = experience.outcome === 'uncertain';
  return {
    experience_id: experience.id,
    what_happened: `${experience.action || 'acao'} terminou com outcome=${experience.outcome}`,
    expected: experience.expected_result || 'execução bem-sucedida dentro das políticas operacionais',
    actual: experience.actual_result || experience.error || experience.outcome,
    why: isUncertain
      ? 'Resultado externo ambíguo ou interrompido; requer conferência humana sem replay automático.'
      : (experience.error || (feedbackSummary?.hasExplicitHuman ? 'Feedback explícito humano recebido.' : 'Observação operacional registrada.')),
    what_worked: isFailure ? 'Isolamento seguro e registro da experiência para prevenção futura.' : (experience.action || 'Estratégia aplicada gerou resultado positivo.'),
    what_failed: isFailure ? (experience.error || experience.actual_result || 'Falha na ação executada.') : '',
    pattern: `${experience.source}:${experience.action}:${experience.outcome}`,
    next_adjustment: isUncertain
      ? 'Manter bloqueio de repetição automática e aguardar validação humana.'
      : (isFailure ? 'Criar aprendizado candidato/hipótese para ajustar abordagem sem alterar código.' : 'Reforçar evidência positiva com escopo controlado.'),
    generated_by: 'deterministic'
  };
}

export function createLearningEngine({
  store,
  ai = null,
  isSuppressed = null,
  reflectionCooldownMs = DEFAULT_REFLECTION_COOLDOWN_MS,
  reflectionWindowMs = DEFAULT_REFLECTION_WINDOW_MS,
  maxReflectionsPerWindow = DEFAULT_MAX_REFLECTIONS_PER_WINDOW,
  logger = console,
  now = () => Date.now()
} = {}) {
  const learningStore = store || new LiaLearningStore({ logger, now });
  const experiences = new ExperienceStore({ store: learningStore, now });
  const feedback = new FeedbackEngine({ experienceStore: experiences, now });
  const knowledge = new KnowledgeStore({ store: learningStore, now });
  const relationships = new RelationshipLearningStore({ store: learningStore, now });
  const regressions = new RegressionKnowledgeStore({ store: learningStore, now });
  const hypotheses = new HypothesisEngine({ store: learningStore, now });
  const strategies = new StrategyRegistry({ store: learningStore, now });
  const experiments = new ExperimentEngine({ store: learningStore, isSuppressed, now });

  const reflectionTimestamps = [];
  let lastReflectionAt = 0;
  let aiCreditsExhaustedUntil = 0;

  const start = async () => {
    await learningStore.load();
    if (learningStore.available) {
      await learningStore.purgeExpiredExperiences(now()).catch(() => {});
    }
    return { ok: learningStore.available, mode: learningStore.mode };
  };

  const canReflectNow = () => {
    const current = now();
    while (reflectionTimestamps.length && current - reflectionTimestamps[0] > reflectionWindowMs) {
      reflectionTimestamps.shift();
    }
    if (reflectionTimestamps.length >= maxReflectionsPerWindow) {
      return { allowed: false, reason: 'reflection_quota_exceeded' };
    }
    if (lastReflectionAt && current - lastReflectionAt < reflectionCooldownMs) {
      return { allowed: false, reason: 'reflection_cooldown_active' };
    }
    return { allowed: true };
  };

  const registerImprovementProposal = async ({ proposalType, summary, rationale = '', metadata = {} } = {}) => {
    const nowIso = new Date(now()).toISOString();
    const record = {
      id: crypto.randomUUID(),
      proposal_type: sanitizeLearningString(proposalType || 'improvement_proposal', 80),
      summary: sanitizeLearningString(summary || 'Proposta de melhoria aguardando revisão humana.', 300),
      rationale: sanitizeLearningString(rationale, 600),
      status: 'pending_human_review',
      metadata: sanitizeLearningData(metadata && typeof metadata === 'object' ? metadata : {}),
      created_at: nowIso,
      updated_at: nowIso
    };
    return learningStore.upsertInCollection('proposals', 'lia_improvement_proposals', record);
  };

  const listProposals = async () => learningStore.listCollection('proposals', 'lia_improvement_proposals', 200);

  /**
   * Valida qualquer ação de autoaperfeiçoamento na fronteira ALLOW/DENY.
   * Propostas negadas (ex.: alteração de código/segurança/permissões) viram
   * `improvement_proposal` aguardando validação humana, sem executar nada.
   */
  const requestSelfImprovement = async (actionType, { summary = '', rationale = '', metadata = {} } = {}) => {
    const check = enforceSelfImprovementBoundary(actionType, metadata);
    if (!check.allowed) {
      const proposal = await registerImprovementProposal({
        proposalType: check.actionType,
        summary: summary || check.reason,
        rationale: rationale || check.reason,
        metadata: { ...metadata, blocked_by_boundary: true }
      });
      return { allowed: false, proposal, reason: check.reason };
    }
    return { allowed: true, actionType: check.actionType };
  };

  const reflectOnExperience = async (experienceId, { bypassCooldown = false } = {}) => {
    const exp = await experiences.get(experienceId);
    if (!exp) return { reflected: false, reason: 'experience_not_found' };
    const fbSummary = feedback.summarize(exp);
    if (!shouldReflectOnExperience(exp, fbSummary)) {
      return { reflected: false, reason: 'not_significant_enough' };
    }
    if (!bypassCooldown) {
      const quota = canReflectNow();
      if (!quota.allowed) return { reflected: false, reason: quota.reason };
    }

    let reflection = buildDeterministicReflection(exp, fbSummary);
    const currentMs = now();

    // Enriquecimento opcional por IA com proteção contra falta de créditos (sem retry loop)
    if (ai?.askAI && currentMs >= aiCreditsExhaustedUntil) {
      try {
        const aiRes = await ai.askAI({
          system: 'Resuma em JSON {"why":"...","next_adjustment":"..."} o aprendizado operacional desta experiência. Não sugira editar código nem remover segurança.',
          history: [],
          userText: JSON.stringify({
            action: exp.action,
            outcome: exp.outcome,
            error: exp.error,
            feedback: fbSummary
          }),
          disableToolCalling: true
        });
        if (aiRes?.provider_error === 'AI_PROVIDER_CREDITS_EXHAUSTED') {
          aiCreditsExhaustedUntil = currentMs + 60 * 60 * 1000;
          reflection.ai_fallback_reason = 'AI_PROVIDER_CREDITS_EXHAUSTED';
        }
      } catch (err) {
        if (/402|credit|billing|quota/i.test(String(err?.message || ''))) {
          aiCreditsExhaustedUntil = currentMs + 60 * 60 * 1000;
          reflection.ai_fallback_reason = 'AI_PROVIDER_CREDITS_EXHAUSTED';
        }
      }
    }

    lastReflectionAt = currentMs;
    reflectionTimestamps.push(currentMs);
    await experiences.markReflected(exp.id, reflection);

    // Gera aprendizado candidato (nunca vira regra consolidada imediatamente!)
    let learned = null;
    if (exp.outcome !== 'uncertain') {
      const kind = exp.outcome === 'failure' ? 'hypothesis' : 'inference';
      const content = exp.outcome === 'failure'
        ? `Evitar padrão "${exp.action}" sem ajuste: ${reflection.next_adjustment}`
        : `Padrão "${exp.action}" apresentou resultado positivo (${exp.outcome}).`;
      learned = await knowledge.create({
        kind,
        scope: exp.scope === 'global' ? 'business' : exp.scope,
        subject: exp.subject,
        topic: exp.action || exp.source,
        content,
        confidence: exp.outcome === 'failure' ? 0.45 : 0.55,
        metadata: { experience_id: exp.id, pattern: reflection.pattern }
      });
    }

    return { reflected: true, reflection, learned };
  };

  /**
   * Processa experiências pendentes relevantes em lote limitado (sem loops infinitos).
   */
  const runLearningCycle = async ({ maxBatch = 5 } = {}) => {
    if (!learningStore.available) return { ok: false, reason: 'learning_unavailable' };
    const unreflected = await experiences.list({ reflected: false, limit: 50 });
    let reflectedCount = 0;
    let learnedCount = 0;
    for (const exp of unreflected.slice(0, Math.max(1, Math.min(20, Number(maxBatch) || 5)))) {
      const res = await reflectOnExperience(exp.id, { bypassCooldown: reflectedCount > 0 });
      if (res.reflected) {
        reflectedCount += 1;
        if (res.learned) learnedCount += 1;
      }
    }
    return { ok: true, inspected: unreflected.length, reflectedCount, learnedCount };
  };

  /**
   * Encerra um experimento concluído e atualiza a confiança da hipótese associada.
   */
  const finalizeExperimentEvaluation = async (experimentId) => {
    const exp = await experiments.get(experimentId);
    if (!exp) return null;
    const evaluation = evaluateExperiment(exp);
    if (exp.hypothesis_id && evaluation.hasAdequateSample && evaluation.winner !== 'inconclusive') {
      await hypotheses.recordEvidence(exp.hypothesis_id, {
        positive: evaluation.winner === 'variant',
        weight: 2,
        note: `Experimento ${exp.id}: winner=${evaluation.winner}, lift=${evaluation.relativeLiftPct}%`
      });
    }
    return evaluation;
  };

  const readiness = () => {
    const available = learningStore.available === true;
    const mode = learningStore.mode;
    return {
      name: 'lia_learning',
      status: available ? 'ready' : 'unavailable',
      mode,
      ...(learningStore.localCorrupt ? { reason: 'local_store_corrupt' } : {}),
      ...(mode === 'local' && !learningStore.localCorrupt ? { reason: 'single_instance_local_fallback' } : {}),
      ...(mode === 'unavailable' && !learningStore.localCorrupt && learningStore.remoteError ? { reason: learningStore.remoteError } : {})
    };
  };

  return {
    store: learningStore,
    experiences,
    feedback,
    knowledge,
    relationships,
    regressions,
    hypotheses,
    strategies,
    experiments,
    start,
    reflectOnExperience,
    runLearningCycle,
    finalizeExperimentEvaluation,
    requestSelfImprovement,
    registerImprovementProposal,
    listProposals,
    readiness,
    get available() { return learningStore.available; },
    get aiCreditsPaused() { return now() < aiCreditsExhaustedUntil; }
  };
}

export {
  LiaLearningStore,
  ExperienceStore,
  FeedbackEngine,
  KnowledgeStore,
  RelationshipLearningStore,
  RegressionKnowledgeStore,
  HypothesisEngine,
  StrategyRegistry,
  ExperimentEngine,
  evaluateExperiment,
  enforceSelfImprovementBoundary
};
