/**
 * Tool: agendar_retorno_ou_followup
 * Permite à Lia agendar um lembrete ou retorno para o atendente/cliente
 */
export const toolAgendarRetorno = {
  name: 'agendar_retorno_ou_followup',
  description: 'Programa um lembrete de retorno ou follow-up para entrar em contato com o cliente em data ou horário específico.',
  parameters: {
    type: 'OBJECT',
    properties: {
      phone: {
        type: 'STRING',
        description: 'Telefone do cliente para o retorno.'
      },
      reason: {
        type: 'STRING',
        description: 'Motivo do retorno ou resumo do assunto a ser tratado.'
      },
      when: {
        type: 'STRING',
        description: 'Data e hora futuras em ISO 8601 com fuso horário (ex: 2026-11-10T16:00:00-03:00). Não use expressões relativas.'
      }
    },
    required: ['reason', 'when']
  },
  async execute({ phone, reason, when }, context = {}) {
    const targetPhone = phone ? String(phone).replace(/\D/g, '') : context.phone;
    const clientName = context.clientName || 'Cliente';
    const reasonText = String(reason || '').trim();
    const whenText = String(when || '').trim();
    const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
    const dueDate = new Date(whenText);
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

      return {
        success: true,
        agendadoPara: dueDate.toISOString(),
        destinatario: clientName,
        motivo: reasonText,
        message: `Lembrete de retorno agendado com sucesso para ${dueDate.toISOString()} com foco em: "${reasonText}".`
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};
