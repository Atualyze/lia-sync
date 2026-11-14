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

      // Consulta no Supabase (suporta REST client próprio store.client.select ou SDK .from)
      const restClient = context.store?.client;
      if (restClient && typeof restClient.select === 'function' && restClient.enabled !== false && (cleanPhone || name)) {
        try {
          const filter = cleanPhone
            ? `or=(phone.eq.${encodeURIComponent(cleanPhone)},phone.ilike.*${encodeURIComponent(cleanPhone.slice(-8))}*)`
            : `or=(display_name.ilike.*${encodeURIComponent(String(name).replace(/[*%,()]/g, ''))}*,push_name.ilike.*${encodeURIComponent(String(name).replace(/[*%,()]/g, ''))}*)`;
          const rows = await restClient.select('contacts', `select=id,phone,display_name,push_name,metadata,created_at&${filter}&limit=1`);
          if (Array.isArray(rows) && rows[0]) {
            const r = rows[0];
            contact = {
              name: r.display_name || r.push_name || 'Cliente',
              phone: r.phone,
              customer_type: r.metadata?.dealStage || r.metadata?.customer_type || 'lead',
              labels: r.metadata?.labels || [],
              notes: r.metadata?.contactNotes || r.metadata?.notes || ''
            };
          }
        } catch {}
      } else if (supabase && cleanPhone && typeof supabase.from === 'function') {
        const { data, error } = await supabase
          .from('contacts')
          .select('id, name, phone, customer_type, notes, labels, created_at')
          .or(`phone.eq.${cleanPhone},phone.ilike.%${cleanPhone.slice(-8)}%`)
          .limit(1)
          .maybeSingle();

        if (data && !error) contact = data;
      }

      // Fallback para sessões realmente existentes; não use store.get(), pois
      // SessionStore.get cria uma sessão vazia e produziria um falso contato.
      if (!contact && context.store) {
        const target = cleanPhone || String(context.phone || '').replace(/\D/g, '');
        const targetName = String(name || '').trim().toLowerCase();
        const sessions = Object.values(context.store.sessions || {});
        let session = target
          ? sessions.find(item => String(item?.phone || '').replace(/\D/g, '') === target)
          : null;
        if (!session && targetName) session = sessions.find(item => [item?.clientName, item?.contactName, item?.pushName].some(value => String(value || '').toLowerCase().includes(targetName)));
        if (!session && context.session && (!target || String(context.session.phone || '').replace(/\D/g, '') === target)) session = context.session;
        if (session) {
          contact = {
            name: session.clientName || session.pushName || 'Cliente',
            phone: session.phone || target || context.phone,
            labels: session.labels || [],
            notes: session.contactNotes || session.crmNotes || session.notes || '',
            customer_type: session.dealStage || 'lead'
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
