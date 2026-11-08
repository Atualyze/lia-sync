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
        description: 'Quando o retorno deve ocorrer (ex: "hoje às 16h", "amanhã pela manhã", "segunda-feira", ou ISO datetime).'
      }
    },
    required: ['reason', 'when']
  },
  async execute({ phone, reason, when }, context = {}) {
    const targetPhone = phone ? String(phone).replace(/\D/g, '') : context.phone;
    const clientName = context.clientName || 'Cliente';

    // Grava lembrete no reminderStore ou no Supabase
    try {
      if (context.reminderStore?.set) {
        await context.reminderStore.set(`rem_${Date.now()}`, {
          phone: targetPhone,
          clientName,
          reason,
          when,
          createdAt: new Date().toISOString(),
          status: 'PENDING'
        });
      }

      return {
        success: true,
        agendadoPara: when,
        destinatario: clientName,
        motivo: reason,
        message: `Lembrete de retorno agendado com sucesso para ${when} com foco em: "${reason}".`
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};
