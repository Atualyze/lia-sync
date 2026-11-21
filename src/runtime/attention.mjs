const PRIORITY_WEIGHT = Object.freeze({
  low: 15,
  medium: 40,
  high: 70,
  critical: 95
});

const HIGH_RISK_KEYWORDS = /\b(?:pix|cobranc\w*|pagament\w*|dispar\w*|enviar_mensagem|outbound|codigo|c[oó]digo|configura[cç][aã]o|deploy)\b/i;

/**
 * Ferramentas estritamente somente-leitura elegíveis para planejamento
 * autônomo seguro pelo Runtime via `copilot_tasks`.
 * Pix, outbound, mutações de CRM, código e configuração NUNCA entram aqui.
 */
export const SAFE_RUNTIME_READ_TOOLS = Object.freeze(new Set([
  'consultar_saude_infra',
  'consultar_contato_ou_lead',
  'consultar_base_conhecimento',
  'consultar_dados_brasil',
  'consultar_web'
]));

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function priorityFromScore(score, risk) {
  if (score >= 85 || risk === 'critical') return 'critical';
  if (score >= 65 || risk === 'high') return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

function findRelatedGoals(event, activeGoals = []) {
  const subject = String(event?.subject || '').toLowerCase();
  const type = String(event?.type || '').toLowerCase();
  const goalIdFromPayload = event?.payload?.goal_id || event?.payload?.goalId || null;
  return activeGoals.filter(goal => {
    if (goalIdFromPayload && goal.id === goalIdFromPayload) return true;
    const indicator = String(goal.indicator || '').toLowerCase();
    const title = String(goal.title || '').toLowerCase();
    if (type.startsWith('lead.') && (indicator.includes('lead') || title.includes('convers') || title.includes('lead'))) return true;
    if (type === 'followup.due' && (indicator.includes('lead') || indicator.includes('followup') || title.includes('convers'))) return true;
    if (type === 'goal.deadline' && subject === goal.id) return true;
    return false;
  });
}

/**
 * Avalia um evento de forma determinística (sem chamadas de LLM em loop) e
 * produz score de atenção, risco, prioridade, recomendação e plano opcional
 * estritamente somente-leitura.
 */
export function evaluateAttention(event, { activeGoals = [], operatingMode = 'assisted' } = {}) {
  const type = String(event?.type || '');
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const basePriority = PRIORITY_WEIGHT[event?.priority] ?? 40;
  const relatedGoals = findRelatedGoals(event, activeGoals);
  const goalBoost = relatedGoals.some(g => g.priority === 'critical')
    ? 20
    : relatedGoals.some(g => g.priority === 'high')
      ? 12
      : relatedGoals.length > 0
        ? 6
        : 0;

  // Regra de segurança absoluta: efeitos externos incertos nunca são repetidos automaticamente
  if (type === 'task.uncertain') {
    return {
      attention_score: 95,
      relevance: 100,
      urgency: 90,
      impact: 95,
      risk: 'critical',
      opportunity: 0,
      priority: 'critical',
      attention_reason: 'Tarefa terminou em estado incerto; exige conferência humana e bloqueia repetição automática.',
      recommended_action: 'escalate_human',
      requires_human: true,
      related_goal_ids: relatedGoals.map(g => g.id),
      suggested_plan: null
    };
  }

  // Qualquer evento solicitando Pix, cobrança ou disparo outbound exige aprovação humana
  if (payload.requires_pix === true || payload.requires_outbound === true || HIGH_RISK_KEYWORDS.test(String(payload.requested_tool || ''))) {
    return {
      attention_score: clampScore(Math.max(basePriority, 75) + goalBoost),
      relevance: 85,
      urgency: 75,
      impact: 85,
      risk: 'high',
      opportunity: 50,
      priority: 'high',
      attention_reason: 'Evento envolve ação sensível (Pix, outbound ou alteração); requer autorização humana explícita.',
      recommended_action: 'escalate_human',
      requires_human: true,
      related_goal_ids: relatedGoals.map(g => g.id),
      suggested_plan: null
    };
  }

  // Eventos de baixo sinal ou ruído irrelevante
  if (payload.irrelevant === true || (type === 'message.received' && !payload.needs_attention && event?.priority === 'low')) {
    return {
      attention_score: 10,
      relevance: 10,
      urgency: 5,
      impact: 10,
      risk: 'low',
      opportunity: 5,
      priority: 'low',
      attention_reason: 'Evento de baixa relevância operacional; nenhuma ação necessária.',
      recommended_action: 'ignore',
      requires_human: false,
      related_goal_ids: [],
      suggested_plan: null
    };
  }

  if (type === 'system.health_change' || type === 'system.error') {
    const severe = event?.priority === 'critical' || payload.healthy === false || payload.severity === 'critical';
    const score = clampScore((severe ? 80 : 55) + goalBoost);
    const risk = severe ? 'high' : 'medium';
    const canInvestigate = operatingMode !== 'passive' && payload.investigate !== false;
    return {
      attention_score: score,
      relevance: 90,
      urgency: severe ? 85 : 55,
      impact: severe ? 85 : 50,
      risk,
      opportunity: 10,
      priority: priorityFromScore(score, risk),
      attention_reason: 'Alteração de saúde ou erro operacional detectado; diagnóstico somente-leitura recomendado.',
      recommended_action: canInvestigate ? 'enqueue_read_task' : 'observe',
      requires_human: severe,
      related_goal_ids: relatedGoals.map(g => g.id),
      suggested_plan: canInvestigate
        ? [{ name: 'consultar_saude_infra', args: { target: String(payload.target || 'geral').slice(0, 40) } }]
        : null
    };
  }

  if (type === 'commitment.due') {
    const score = clampScore(72 + goalBoost);
    return {
      attention_score: score,
      relevance: 90,
      urgency: 85,
      impact: 70,
      risk: 'medium',
      opportunity: 60,
      priority: priorityFromScore(score, 'medium'),
      attention_reason: 'Compromisso persistente atingiu o prazo; requer acompanhamento ou ação aprovada.',
      recommended_action: 'notify_owner',
      requires_human: true,
      related_goal_ids: relatedGoals.map(g => g.id),
      suggested_plan: null
    };
  }

  if (type === 'goal.deadline') {
    const score = clampScore(78 + goalBoost);
    return {
      attention_score: score,
      relevance: 95,
      urgency: 85,
      impact: 80,
      risk: 'medium',
      opportunity: 70,
      priority: priorityFromScore(score, 'medium'),
      attention_reason: 'Objetivo ativo atingiu o prazo definido; revisão de progresso necessária.',
      recommended_action: 'notify_owner',
      requires_human: true,
      related_goal_ids: relatedGoals.map(g => g.id),
      suggested_plan: null
    };
  }

  if (type === 'lead.created' || type === 'lead.updated' || type === 'followup.due') {
    const leadScore = Number(payload.score || 0);
    const daysWithoutContact = Number(payload.days_without_contact || 0);
    const opportunity = clampScore(Math.max(40, leadScore) + Math.min(20, daysWithoutContact * 5));
    const score = clampScore(Math.round((basePriority * 0.4) + (opportunity * 0.6) + goalBoost));
    const isHigh = score >= 65;
    const phone = String(payload.phone || event?.subject || '').replace(/\D/g, '');
    const canLookup = isHigh && operatingMode !== 'passive' && phone.length >= 8;
    return {
      attention_score: score,
      relevance: isHigh ? 85 : 45,
      urgency: daysWithoutContact >= 2 ? 75 : 45,
      impact: isHigh ? 75 : 40,
      risk: 'medium',
      opportunity,
      priority: priorityFromScore(score, 'medium'),
      attention_reason: isHigh
        ? 'Lead/follow-up relevante detectado; consultar contexto antes de propor ação sujeita à política de outbound.'
        : 'Atualização comercial registrada para observação.',
      recommended_action: canLookup ? 'enqueue_read_task' : (isHigh ? 'notify_owner' : 'observe'),
      requires_human: isHigh, // Outbound nunca é disparado automaticamente pelo Runtime
      related_goal_ids: relatedGoals.map(g => g.id),
      suggested_plan: canLookup
        ? [{ name: 'consultar_contato_ou_lead', args: { termo: phone } }]
        : null
    };
  }

  if (type === 'task.failed' || type === 'task.expired') {
    const score = clampScore(68 + goalBoost);
    return {
      attention_score: score,
      relevance: 80,
      urgency: 70,
      impact: 65,
      risk: 'medium',
      opportunity: 15,
      priority: priorityFromScore(score, 'medium'),
      attention_reason: 'Tarefa operacional falhou ou expirou; registrar para revisão sem repetição insegura.',
      recommended_action: 'notify_owner',
      requires_human: true,
      related_goal_ids: relatedGoals.map(g => g.id),
      suggested_plan: null
    };
  }

  // Padrão para demais eventos informativos (goal.created, task.completed, calendar.event_due, etc.)
  const score = clampScore(Math.min(55, basePriority + goalBoost));
  const action = score >= 35 ? 'observe' : 'ignore';
  return {
    attention_score: score,
    relevance: score,
    urgency: Math.min(50, basePriority),
    impact: Math.min(50, basePriority),
    risk: 'low',
    opportunity: 20,
    priority: priorityFromScore(score, 'low'),
    attention_reason: action === 'ignore'
      ? 'Evento informativo abaixo do limiar de atenção.'
      : 'Evento registrado no estado operacional para acompanhamento.',
    recommended_action: action,
    requires_human: false,
    related_goal_ids: relatedGoals.map(g => g.id),
    suggested_plan: null
  };
}
