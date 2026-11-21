import crypto from 'node:crypto';
import { sanitizeLearningData, sanitizeLearningString } from './boundary.mjs';
import { LEARNING_SCOPES } from './experience.mjs';

export const KNOWLEDGE_KINDS = Object.freeze(['fact', 'inference', 'hypothesis', 'strategy', 'rule', 'preference']);
export const CONFIDENCE_STATUSES = Object.freeze([
  'candidate', 'experimental', 'supported', 'consolidated', 'deprecated', 'contradicted'
]);

const KIND_SET = new Set(KNOWLEDGE_KINDS);
const SCOPE_SET = new Set(LEARNING_SCOPES);
const SCOPE_SPECIFICITY = Object.freeze({
  individual: 5,
  relationship: 4,
  segment: 3,
  business: 2,
  global: 1
});

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.5;
  return Number(Math.max(0, Math.min(1, num)).toFixed(4));
}

export function deriveConfidenceStatus({ confidence, evidenceCount, positiveEvidence, negativeEvidence }) {
  if (negativeEvidence >= 3 && confidence < 0.35) return 'contradicted';
  if (negativeEvidence >= 2 && confidence < 0.55) return 'deprecated';
  if (evidenceCount >= 10 && confidence >= 0.85 && negativeEvidence === 0) return 'consolidated';
  if (evidenceCount >= 5 && confidence >= 0.75) return 'supported';
  if (evidenceCount >= 2 && confidence >= 0.5) return 'experimental';
  return 'candidate';
}

export class KnowledgeStore {
  constructor({ store, now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
  }

  async create({
    kind = 'inference',
    scope = 'business',
    subject = '',
    topic = '',
    content,
    confidence = 0.5,
    metadata = {}
  } = {}) {
    const cleanContent = sanitizeLearningString(content, 800).trim();
    if (!cleanContent) throw new Error('knowledge_content_required');
    const cleanKind = KIND_SET.has(kind) ? kind : 'inference';
    const cleanScope = SCOPE_SET.has(scope) ? scope : 'business';
    // Regra: preferência individual/relacional nunca nasce como regra global
    if ((cleanKind === 'preference' || cleanScope === 'individual' || cleanScope === 'relationship') && cleanScope === 'global') {
      throw new Error('individual_preference_cannot_be_global');
    }
    const nowIso = new Date(this.now()).toISOString();
    // Aprendizado novo nunca entra direto como regra consolidada sem evidência
    const initialConfidence = clampConfidence(Math.min(0.65, Number(confidence) || 0.5));
    const record = {
      id: crypto.randomUUID(),
      kind: cleanKind,
      scope: cleanScope,
      subject: sanitizeLearningString(subject, 160),
      topic: sanitizeLearningString(topic, 120),
      content: cleanContent,
      confidence: initialConfidence,
      evidence_count: 1,
      positive_evidence: 1,
      negative_evidence: 0,
      last_validated_at: nowIso,
      last_invalidated_at: null,
      status: 'candidate',
      history: [{ at: nowIso, action: 'created', confidence: initialConfidence, status: 'candidate' }],
      metadata: sanitizeLearningData(metadata && typeof metadata === 'object' ? metadata : {}),
      created_at: nowIso,
      updated_at: nowIso
    };
    return this.store.upsertInCollection('knowledge', 'lia_knowledge', record);
  }

  async get(id) {
    return this.store.getFromCollection('knowledge', 'lia_knowledge', id);
  }

  async list({ scope = null, kind = null, status = null, subject = null, topic = null } = {}) {
    const all = await this.store.listCollection('knowledge', 'lia_knowledge', 500);
    return all.filter(item => {
      if (scope && item.scope !== scope) return false;
      if (kind && item.kind !== kind) return false;
      if (status && item.status !== status) return false;
      if (subject && item.subject !== subject) return false;
      if (topic && item.topic !== topic) return false;
      return true;
    });
  }

  /**
   * Atualiza confiança com evidência positiva ou negativa (aprendizado e desaprendizado).
   * Preserva histórico completo em `history` sem apagar conhecimento anterior.
   */
  async recordEvidence(id, { positive = true, weight = 1, reason = '' } = {}) {
    const current = await this.get(id);
    if (!current) return null;
    const nowIso = new Date(this.now()).toISOString();
    const w = Math.max(0.25, Math.min(3, Number(weight) || 1));
    const nextPositive = Number(current.positive_evidence || 0) + (positive ? 1 : 0);
    const nextNegative = Number(current.negative_evidence || 0) + (positive ? 0 : 1);
    const nextCount = Number(current.evidence_count || 0) + 1;

    // Atualização suave baseada em proporção + decaimento explícito em falhas
    const delta = positive
      ? (1 - Number(current.confidence)) * (0.14 * w)
      : -Number(current.confidence) * (0.22 * w);
    const nextConfidence = clampConfidence(Number(current.confidence) + delta);
    const nextStatus = deriveConfidenceStatus({
      confidence: nextConfidence,
      evidenceCount: nextCount,
      positiveEvidence: nextPositive,
      negativeEvidence: nextNegative
    });

    const history = [
      ...(Array.isArray(current.history) ? current.history : []),
      {
        at: nowIso,
        action: positive ? 'evidence_positive' : 'evidence_negative',
        weight: w,
        confidence: nextConfidence,
        status: nextStatus,
        reason: sanitizeLearningString(reason, 180)
      }
    ].slice(-50);

    return this.store.upsertInCollection('knowledge', 'lia_knowledge', {
      ...current,
      confidence: nextConfidence,
      evidence_count: nextCount,
      positive_evidence: nextPositive,
      negative_evidence: nextNegative,
      last_validated_at: positive ? nowIso : current.last_validated_at,
      last_invalidated_at: positive ? current.last_invalidated_at : nowIso,
      status: nextStatus,
      history
    });
  }

  /**
   * Impede promoção indevida de preferência individual para escopo global.
   */
  async updateScope(id, nextScope) {
    const current = await this.get(id);
    if (!current) return null;
    if (!SCOPE_SET.has(nextScope)) throw new Error('invalid_learning_scope');
    if ((current.scope === 'individual' || current.scope === 'relationship' || current.kind === 'preference') && nextScope === 'global') {
      throw new Error('individual_preference_cannot_promote_to_global');
    }
    return this.store.upsertInCollection('knowledge', 'lia_knowledge', {
      ...current,
      scope: nextScope
    });
  }

  /**
   * Resolve conflito entre dois conhecimentos ponderando evidência, confiança,
   * especificidade de escopo e recência — nunca "última memória vence".
   */
  resolveConflict(knowledgeA, knowledgeB, { nowMs = this.now() } = {}) {
    const score = (k) => {
      if (!k) return -1;
      const conf = Number(k.confidence || 0) * 45;
      const evidence = Math.min(25, Math.log2(Math.max(1, Number(k.evidence_count || 1))) * 8);
      const spec = (SCOPE_SPECIFICITY[k.scope] || 1) * 4;
      const ageDays = Math.max(0, (nowMs - (Date.parse(k.last_validated_at || k.updated_at || '') || nowMs)) / 86400000);
      const recency = Math.max(0, 10 - ageDays * 0.25);
      const penalty = (k.status === 'deprecated' || k.status === 'contradicted') ? -30 : 0;
      return conf + evidence + spec + recency + penalty;
    };
    const scoreA = score(knowledgeA);
    const scoreB = score(knowledgeB);
    return scoreA >= scoreB
      ? { winner: knowledgeA, loser: knowledgeB, scores: { a: Number(scoreA.toFixed(2)), b: Number(scoreB.toFixed(2)) } }
      : { winner: knowledgeB, loser: knowledgeA, scores: { a: Number(scoreA.toFixed(2)), b: Number(scoreB.toFixed(2)) } };
  }
}

export class RelationshipLearningStore {
  constructor({ store, now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
  }

  _id(subject, tenantScope = 'default') {
    return `${sanitizeLearningString(tenantScope, 60)}:${sanitizeLearningString(subject, 120)}`;
  }

  async get(subject, tenantScope = 'default') {
    return this.store.getRelationship(this._id(subject, tenantScope));
  }

  async update(subject, patch = {}, tenantScope = 'default') {
    const cleanSubject = sanitizeLearningString(subject, 120).trim();
    if (!cleanSubject) throw new Error('relationship_subject_required');
    const id = this._id(cleanSubject, tenantScope);
    const current = await this.store.getRelationship(id);
    const nowIso = new Date(this.now()).toISOString();
    const mergeUnique = (prev = [], next = []) => [...new Set([...prev, ...next].map(x => sanitizeLearningString(x, 120)).filter(Boolean))].slice(-20);

    const record = {
      id,
      subject: cleanSubject,
      tenant_scope: sanitizeLearningString(tenantScope, 60),
      preferences: { ...(current?.preferences || {}), ...(patch.preferences ? sanitizeLearningData(patch.preferences) : {}) },
      best_hours: patch.best_hours ? mergeUnique(current?.best_hours, patch.best_hours) : (current?.best_hours || []),
      interests: patch.interests ? mergeUnique(current?.interests, patch.interests) : (current?.interests || []),
      objections: patch.objections ? mergeUnique(current?.objections, patch.objections) : (current?.objections || []),
      response_patterns: { ...(current?.response_patterns || {}), ...(patch.response_patterns ? sanitizeLearningData(patch.response_patterns) : {}) },
      commercial_stage: patch.commercial_stage !== undefined ? sanitizeLearningString(patch.commercial_stage, 80) : (current?.commercial_stage || ''),
      sensitivity: patch.sensitivity !== undefined ? sanitizeLearningString(patch.sensitivity, 40) : (current?.sensitivity || 'normal'),
      contact_frequency: patch.contact_frequency !== undefined ? sanitizeLearningString(patch.contact_frequency, 40) : (current?.contact_frequency || 'normal'),
      last_interaction_at: patch.last_interaction_at || nowIso,
      metadata: { ...(current?.metadata || {}), ...(patch.metadata ? sanitizeLearningData(patch.metadata) : {}) },
      created_at: current?.created_at || nowIso,
      updated_at: nowIso
    };
    return this.store.upsertRelationship(record);
  }
}

export class RegressionKnowledgeStore {
  constructor({ store, now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
  }

  async register({
    problemPattern,
    expectedBehavior,
    forbiddenBehavior,
    testReference = '',
    status = 'active',
    metadata = {}
  } = {}) {
    const cleanPattern = sanitizeLearningString(problemPattern, 300).trim();
    const cleanExpected = sanitizeLearningString(expectedBehavior, 300).trim();
    const cleanForbidden = sanitizeLearningString(forbiddenBehavior, 300).trim();
    if (!cleanPattern || !cleanExpected || !cleanForbidden) {
      throw new Error('regression_fields_required');
    }
    const nowIso = new Date(this.now()).toISOString();
    const record = {
      id: crypto.randomUUID(),
      problem_pattern: cleanPattern,
      expected_behavior: cleanExpected,
      forbidden_behavior: cleanForbidden,
      test_reference: sanitizeLearningString(testReference, 160),
      status: ['candidate', 'active', 'verified', 'deprecated'].includes(status) ? status : 'active',
      metadata: sanitizeLearningData(metadata && typeof metadata === 'object' ? metadata : {}),
      created_at: nowIso,
      updated_at: nowIso
    };
    return this.store.upsertInCollection('regressions', 'lia_regressions', record);
  }

  async list({ status = null } = {}) {
    const all = await this.store.listCollection('regressions', 'lia_regressions', 200);
    return status ? all.filter(item => item.status === status) : all;
  }

  async exportTestSpecs() {
    const active = await this.list({ status: 'active' });
    return active.map(item => ({
      id: item.id,
      pattern: item.problem_pattern,
      expect: item.expected_behavior,
      forbid: item.forbidden_behavior,
      testRef: item.test_reference
    }));
  }
}
