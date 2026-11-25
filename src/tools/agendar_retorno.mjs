/**
 * Tool: agendar_retorno_ou_followup
 * Agenda retornos e permite auto-consulta dos lembretes do contato autenticado.
 */
export const toolAgendarRetorno = {
  name: 'agendar_retorno_ou_followup',
  description: 'Agenda um retorno com assunto, dia e horário explícitos. Também lista, conta ou confirma o lembrete mais recente SOMENTE do telefone autenticado desta conversa; nunca consulta outros contatos nem a agenda privada do responsável.',
  parameters: {
    type: 'OBJECT',
    properties: {
      action: {
        type: 'STRING',
        enum: ['agendar', 'listar', 'contar', 'ultimo'],
        description: 'Ação: agendar (padrão), listar ou contar lembretes do próprio contato autenticado, ou ultimo para confirmar o lembrete pendente mais recente.'
      },
      phone: {
        type: 'STRING',
        description: 'Telefone do cliente para o retorno. Em consultas, ignore este campo e use somente o telefone autenticado da sessão.'
      },
      reason: {
        type: 'STRING',
        description: 'Assunto concreto informado pelo cliente para o retorno. Não invente conteúdo nem use apenas o nome do cliente.'
      },
      when: {
        type: 'STRING',
        description: 'Data e hora futuras em ISO 8601 com fuso horário, convertidas somente de dia e horário expressamente informados pelo cliente. Não use horário padrão nem invente data.'
      }
    },
    required: []
  },
  async execute({ action: requestedAction, phone, reason, when }, context = {}) {
    const action = String(requestedAction || 'agendar').trim().toLowerCase();
    if (!['agendar', 'listar', 'contar', 'ultimo'].includes(action)) {
      return { success: false, error: 'invalid_reminder_action', message: 'Ação de lembrete inválida.' };
    }

    const rawSessionPhone = String(context.phone || '').trim();
    const isSandboxSession = ['simulation', 'preview'].includes(String(context.origin || '').toLowerCase())
      || /^sim:/i.test(rawSessionPhone);
    if (isSandboxSession) {
      return { success: false, error: 'reminder_sandbox_session', message: 'Consultas e gravações de lembretes não são executadas em sessões de simulação.' };
    }
    const sessionPhone = rawSessionPhone;
    const clientPhoneValid = /^\d{8,15}$/.test(sessionPhone) || /^\d+@lid$/i.test(sessionPhone);

    // Consultas de lembretes são estritamente autoatendimento: o telefone vem
    // da sessão autenticada, nunca de um argumento fornecido pelo usuário.
    if (action !== 'agendar') {
      if (context.actor !== 'client') {
        return { success: false, error: 'reminder_query_client_scope_only', message: 'A consulta de lembretes exige o contato autenticado.' };
      }
      if (!clientPhoneValid) {
        return { success: false, error: 'invalid_authenticated_contact', message: 'Não consegui validar o contato desta conversa para consultar os lembretes.' };
      }
      if (typeof context.reminderStore?.listActiveForPhone !== 'function') {
        return { success: false, error: 'reminder_query_unavailable', message: 'Não consegui consultar os lembretes deste contato agora.' };
      }

      const ownReminders = (await context.reminderStore.listActiveForPhone(sessionPhone))
        .slice()
        .sort((a, b) => {
          const createdDelta = Date.parse(b.createdAt || '') - Date.parse(a.createdAt || '');
          if (Number.isFinite(createdDelta) && createdDelta !== 0) return createdDelta;
          return Date.parse(b.dueAt || 0) - Date.parse(a.dueAt || 0);
        });
      if (action === 'contar') {
        return {
          success: true,
          action,
          count: ownReminders.length,
          message: ownReminders.length
            ? 'Há ' + ownReminders.length + ' lembrete(s) pendente(s) associado(s) a este contato.'
            : 'Não há lembretes pendentes associados a este contato.'
        };
      }
      if (action === 'ultimo') {
        const latest = ownReminders[0] || null;
        return {
          success: true,
          action,
          reminder: latest ? {
            id: latest.id,
            text: latest.text,
            dueAt: latest.dueAt,
            status: latest.status,
            createdAt: latest.createdAt
          } : null,
          message: latest
            ? 'Encontrei o lembrete pendente mais recente associado a este contato.'
            : 'Não encontrei lembretes pendentes associados a este contato.'
        };
      }
      return {
        success: true,
        action,
        count: ownReminders.length,
        reminders: ownReminders.slice(0, 50).map(item => ({
          id: item.id,
          text: item.text,
          dueAt: item.dueAt,
          status: item.status,
          createdAt: item.createdAt
        })),
        message: ownReminders.length
          ? 'Encontrei ' + ownReminders.length + ' lembrete(s) pendente(s) associado(s) a este contato.'
          : 'Não há lembretes pendentes associados a este contato.'
      };
    }

    const clientPhone = clientPhoneValid ? sessionPhone : '';
    const targetPhone = context.actor === 'client'
      ? clientPhone
      : (phone ? String(phone).replace(/\D/g, '') : context.phone);
    const clientName = context.clientName || 'Cliente';
    const reasonText = String(reason || '').trim();
    const whenText = String(when || '').trim();
    const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
    const dueDate = new Date(whenText);
    if (context.actor === 'client' && !clientPhoneValid) {
      return { success: false, error: 'Invalid session phone for reminder.' };
    }
    if (!reasonText) return { success: false, error: 'Informe um motivo válido para o lembrete.' };
    if (!isoDateTime.test(whenText) || !Number.isFinite(dueDate.getTime()) || dueDate.getTime() <= Date.now()) {
      return { success: false, error: 'Informe uma data e hora futura em ISO 8601 com fuso horário.' };
    }

    // A confirmação só é liberada após a persistência realizada pelo ReminderStore.
    try {
      if (typeof context.reminderStore?.add !== 'function') throw new Error('Módulo de lembretes indisponível');
      const reminder = await context.reminderStore.add({
        text: reasonText,
        dueAt: dueDate.toISOString(),
        phone: targetPhone || '',
        clientName,
        createdBy: 'lia'
      });
      if (!reminder?.id) throw new Error('Lembrete não foi persistido');

      const timezone = context.botConfig?.business?.hoursConfig?.timezone
        || context.botConfig?.business?.timezone
        || 'America/Sao_Paulo';
      const dueLabel = new Intl.DateTimeFormat('pt-BR', {
        timeZone: timezone,
        dateStyle: 'long',
        timeStyle: 'short'
      }).format(dueDate);
      return {
        success: true,
        agendadoPara: dueDate.toISOString(),
        destinatario: clientName,
        motivo: reasonText,
        reminderId: reminder.id,
        message: 'Lembrete de retorno registrado para ' + dueLabel
          + ', associado a este contato: "' + reasonText
          + '". O sistema tentará avisar o responsável no horário programado. Este registro não é um evento do Google Agenda.'
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};
