const ALLOWED_AUTONOMOUS_TOOLS = new Set([
  'consultar_saude_infra',
  'consultar_web',
  'consultar_contato_ou_lead',
  'consultar_base_conhecimento',
  'consultar_dados_brasil',
  'consultar_planilha_google',
  'gerenciar_drive_google',
  'gerenciar_agenda_google',
  'gerenciar_gmail_google'
]);

function resolveDueAt({ dueAt, inMinutes }, nowMs = Date.now()) {
  if (Number.isFinite(Number(inMinutes)) && Number(inMinutes) > 0) {
    const mins = Math.max(1, Math.min(43200, Math.round(Number(inMinutes))));
    return new Date(nowMs + mins * 60_000).toISOString();
  }
  if (typeof dueAt === 'string' && dueAt.trim()) {
    const parsed = Date.parse(dueAt.trim());
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  // Padrão seguro: 5 minutos se não informado
  return new Date(nowMs + 5 * 60_000).toISOString();
}

export const toolGerenciarTarefasAutonomas = {
  name: 'gerenciar_tarefas_autonomas',
  description:
    'Cria, lista e conclui objetivos persistentes e verificações/compromissos agendados no Lia Runtime (ex.: "verifique a saúde das APIs em 10 minutos e me avise", "acompanhe o cliente amanhã às 9h"). O Runtime acorda no horário, executa a consulta segura automaticamente e retorna no WhatsApp.',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: {
        type: 'STRING',
        enum: ['agendar_verificacao', 'criar_objetivo', 'listar_pendentes', 'concluir_compromisso', 'cancelar_compromisso'],
        description: 'Ação no motor de autonomia e compromissos persistentes.'
      },
      titulo: {
        type: 'STRING',
        description: 'Título curto do compromisso, verificação ou objetivo.'
      },
      assunto: {
        type: 'STRING',
        description: 'Assunto, cliente ou alvo associado.'
      },
      inMinutes: {
        type: 'NUMBER',
        description: 'Daqui a quantos minutos executar/avisar (ex: 5, 15, 60).'
      },
      dueAt: {
        type: 'STRING',
        description: 'Data/hora ISO 8601 para execução/vencimento (opcional se inMinutes for usado).'
      },
      actionTool: {
        type: 'STRING',
        description: 'Ferramenta somente-leitura opcional a executar automaticamente no horário (ex: consultar_saude_infra, consultar_web, consultar_contato_ou_lead).'
      },
      actionArgs: {
        type: 'OBJECT',
        description: 'Argumentos JSON da ferramenta opcional.'
      },
      prioridade: {
        type: 'STRING',
        enum: ['low', 'normal', 'high', 'critical'],
        description: 'Prioridade do objetivo (para criar_objetivo).'
      },
      indicador: {
        type: 'STRING',
        description: 'Critério de sucesso ou indicador (para criar_objetivo).'
      },
      commitmentId: {
        type: 'STRING',
        description: 'ID (ou prefixo de 8 caracteres) do compromisso (para concluir_compromisso ou cancelar_compromisso).'
      },
      recurrence: {
        type: 'OBJECT',
        description: 'Regra opcional de recorrência ({ kind: "daily" | "weekly" | "interval_minutes", hour, minute, weekday, intervalMinutes }).'
      },
      recurrenceLabel: {
        type: 'STRING',
        description: 'Descrição legível da recorrência (ex.: "todo dia às 08:00").'
      }
    },
    required: ['acao']
  },

  async execute(args = {}, context = {}) {
    if (context?.actor === 'client') {
      return {
        success: false,
        error: 'forbidden_in_client_flow',
        message: 'Gestão de tarefas autônomas do Runtime é exclusiva do Copiloto.'
      };
    }

    const liaRuntime = context?.liaRuntime;
    if (!liaRuntime?.available) {
      return {
        success: false,
        error: 'lia_runtime_unavailable',
        message: 'O Lia Runtime persistente não está disponível neste momento.'
      };
    }

    const acao = String(args.acao || '').trim();
    const nowMs = typeof context?.now === 'function' ? context.now() : Date.now();

    if (acao === 'listar_pendentes') {
      const [activeGoals, pendingCommitments] = await Promise.all([
        liaRuntime.goals.list({ status: 'active' }),
        liaRuntime.commitments.list({ status: 'pending' })
      ]);
      return {
        success: true,
        acao,
        activeGoals: activeGoals.slice(0, 15).map(g => ({
          id: g.id,
          title: g.title,
          priority: g.priority,
          progress: g.progress,
          deadline_at: g.deadline_at
        })),
        pendingCommitments: pendingCommitments.slice(0, 15).map(c => ({
          id: c.id,
          title: c.title,
          subject: c.subject,
          due_at: c.due_at,
          actionTool: c.metadata?.actionTool || null
        }))
      };
    }

    if (acao === 'criar_objetivo') {
      const title = String(args.titulo || '').trim().slice(0, 180);
      if (!title) {
        return { success: false, error: 'missing_title', message: 'Informe um título para o objetivo.' };
      }
      const goal = await liaRuntime.goals.create({
        title,
        priority: ['low', 'normal', 'high', 'critical'].includes(args.prioridade) ? args.prioridade : 'normal',
        indicator: String(args.indicador || args.assunto || 'Concluído e verificado').slice(0, 200),
        deadlineAt: args.dueAt || null,
        status: 'active'
      });
      return {
        success: true,
        acao,
        goal: { id: goal.id, title: goal.title, priority: goal.priority, status: goal.status },
        message: `Objetivo "${goal.title}" registrado no Lia Runtime.`
      };
    }

    if (acao === 'concluir_compromisso' || acao === 'cancelar_compromisso') {
      const rawId = String(args.commitmentId || '').replace(/^#/, '').trim().toLowerCase();
      if (!rawId) return { success: false, error: 'missing_commitment_id', message: 'Informe o commitmentId.' };
      let targetId = rawId;
      if (rawId.length < 36) {
        const pending = await liaRuntime.commitments.list({ status: 'pending' });
        const matched = pending.find(c => String(c.id || '').toLowerCase().startsWith(rawId));
        if (matched) targetId = matched.id;
      }
      const updated = acao === 'cancelar_compromisso'
        ? await liaRuntime.commitments.cancel(targetId)
        : await liaRuntime.commitments.fulfill(targetId);
      if (!updated) return { success: false, error: 'commitment_not_found', message: `Compromisso #${rawId.toUpperCase()} não encontrado.` };
      return {
        success: true,
        acao,
        commitment: { id: updated.id, title: updated.title, status: updated.status },
        message: acao === 'cancelar_compromisso'
          ? `Compromisso/rotina #${String(updated.id).slice(0, 8).toUpperCase()} ("${updated.title}") cancelado.`
          : `Compromisso #${String(updated.id).slice(0, 8).toUpperCase()} marcado como concluído.`
      };
    }

    if (acao === 'agendar_verificacao') {
      const title = String(args.titulo || '').trim().slice(0, 180);
      if (!title) {
        return { success: false, error: 'missing_title', message: 'Informe o título da verificação ou compromisso.' };
      }
      const dueAtIso = resolveDueAt({ dueAt: args.dueAt, inMinutes: args.inMinutes }, nowMs);
      const rawTool = String(args.actionTool || '').trim();
      const actionTool = rawTool && ALLOWED_AUTONOMOUS_TOOLS.has(rawTool) ? rawTool : null;
      const actionArgs = actionTool && args.actionArgs && typeof args.actionArgs === 'object' && !Array.isArray(args.actionArgs)
        ? args.actionArgs
        : {};
      const recurrence = args.recurrence && typeof args.recurrence === 'object' && !Array.isArray(args.recurrence)
        ? args.recurrence
        : null;
      const recurrenceLabel = recurrence ? String(args.recurrenceLabel || '').trim().slice(0, 80) : '';

      const commitment = await liaRuntime.commitments.create({
        title,
        subject: String(args.assunto || 'owner').slice(0, 120),
        dueAt: dueAtIso,
        metadata: {
          source: 'copilot_autonomous',
          ...(actionTool ? { actionTool, actionArgs } : {}),
          ...(recurrence ? { recurrence, recurrenceLabel } : {}),
          notifyOwner: true
        }
      });
      return {
        success: true,
        acao,
        commitmentId: commitment.id,
        dueAt: commitment.due_at,
        recurrence,
        recurrenceLabel,
        commitment: {
          id: commitment.id,
          title: commitment.title,
          due_at: commitment.due_at,
          actionTool,
          recurrence,
          recurrenceLabel
        },
        message: `Verificação/compromisso "${commitment.title}" agendado para ${new Date(commitment.due_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}${recurrenceLabel ? ` (🔁 ${recurrenceLabel})` : ''}${actionTool ? ` (executando ${actionTool} automaticamente)` : ''}.`
      };
    }

    return { success: false, error: 'invalid_action', message: 'Ação não reconhecida.' };
  }
};
