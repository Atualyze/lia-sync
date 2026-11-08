/**
 * Tool: consultar_contato_ou_lead
 * Permite à Lia consultar dados cadastrais, notas e histórico de um contato no Supabase/CRM
 */
export const toolConsultarContato = {
  name: 'consultar_contato_ou_lead',
  description: 'Consulta informações cadastrais, status, notas e histórico de um cliente/lead pelo número de telefone ou nome no CRM.',
  parameters: {
    type: 'OBJECT',
    properties: {
      phone: {
        type: 'STRING',
        description: 'Número de telefone do cliente com DDD (apenas dígitos). Ex: 5586999999999'
      },
      name: {
        type: 'STRING',
        description: 'Nome aproximado do cliente para pesquisa se o telefone não estiver disponível.'
      }
    },
    required: []
  },
  async execute({ phone, name }, context = {}) {
    const supabase = context.supabase;
    if (!supabase && !context.store) {
      return { found: false, message: 'Banco de dados temporariamente indisponível.' };
    }

    try {
      const cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';
      let contact = null;

      // Consulta no Supabase
      if (supabase && cleanPhone) {
        const { data, error } = await supabase
          .from('contacts')
          .select('id, name, phone, customer_type, notes, labels, created_at')
          .or(`phone.eq.${cleanPhone},phone.ilike.%${cleanPhone.slice(-8)}%`)
          .limit(1)
          .maybeSingle();

        if (data && !error) contact = data;
      }

      // Fallback para store local se não encontrou no Supabase
      if (!contact && context.store?.get) {
        const session = await context.store.get(cleanPhone || context.phone);
        if (session) {
          contact = {
            name: session.clientName || session.pushName || 'Cliente',
            phone: cleanPhone || context.phone,
            labels: session.labels || [],
            notes: session.notes || ''
          };
        }
      }

      if (contact) {
        return {
          found: true,
          name: contact.name,
          phone: contact.phone,
          type: contact.customer_type || 'lead',
          labels: contact.labels || [],
          notes: contact.notes || 'Sem observações adicionais.'
        };
      }

      return {
        found: false,
        message: 'Contato ainda não possui cadastro formal no CRM. Pode ser um novo lead.'
      };
    } catch (err) {
      return { found: false, error: err.message };
    }
  }
};
