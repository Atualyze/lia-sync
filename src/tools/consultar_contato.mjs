import { normalizePhone } from '../sessions.mjs';
import { OWNER_SELF_KEY } from '../core/identity.mjs';

function findMatchingSession(sessionsObj = {}, cleanPhone = '', name = '') {
  const sessions = Object.entries(sessionsObj || {})
    .filter(([key, s]) => s && !key.startsWith('sim:') && s.origin !== 'simulation' && s.phone && s.phone !== OWNER_SELF_KEY)
    .map(([, s]) => s);

  if (cleanPhone) {
    const canonical = cleanPhone.length >= 10 ? normalizePhone(cleanPhone) : cleanPhone;
    const exact = sessions.find(item => {
      const d = String(item.phone || '').replace(/\D/g, '');
      return d === cleanPhone || (canonical && normalizePhone(d) === canonical);
    });
    if (exact) return exact;

    if (cleanPhone.length >= 8) {
      const last8 = cleanPhone.slice(-8);
      const suffixMatches = sessions.filter(item => {
        const d = String(item.phone || '').replace(/\D/g, '');
        return d.endsWith(last8);
      });
      if (suffixMatches.length >= 1) {
        return suffixMatches.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
      }
    }
  }

  const targetName = String(name || '').trim().toLowerCase();
  if (targetName) {
    return sessions.find(item =>
      [item.clientName, item.contactName, item.pushName].some(v => String(v || '').toLowerCase().includes(targetName))
    ) || null;
  }

  return null;
}

function buildAttendanceSummary(session) {
  if (!session) return null;
  const history = Array.isArray(session.history) ? session.history : [];
  const recentMessages = history.slice(-10).map(msg => ({
    role: msg.role === 'assistant' ? 'lia' : (msg.role === 'human' ? 'humano' : 'cliente'),
    content: String(msg.content || '').slice(0, 320),
    createdAt: msg.createdAt || null
  }));
  return {
    mode: session.human ? 'humano' : 'bot',
    statusLabel: session.human ? 'Aguardando atendimento humano' : 'Atendimento ativo pela Lia (bot)',
    messageCount: history.length,
    lastUserAt: session.lastUserAt || null,
    lastBotAt: session.lastBotAt || null,
    updatedAt: session.updatedAt || null,
    handoffAt: session.handoffAt || null,
    recentMessages
  };
}

/**
 * Tool: consultar_contato_ou_lead
 * Permite à Lia consultar dados cadastrais, notas e histórico de atendimento de um contato no Supabase/CRM e nas sessões ativas.
 */
export const toolConsultarContato = {
  name: 'consultar_contato_ou_lead',
  description: 'Consulta informações cadastrais, status, notas e histórico recente de atendimento de um cliente/lead pelo número de telefone ou nome.',
  parameters: {
    type: 'OBJECT',
    properties: {
      phone: {
        type: 'STRING',
        description: 'Número de telefone do cliente com DDD (apenas dígitos). Ex: 5588921694598 ou 88921694598'
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

      // 1. Consulta no Supabase (tabela contacts)
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

      // 2. Busca sessão de atendimento correspondente (aceita com/sem 55 e variação do 9º dígito)
      const targetDigits = cleanPhone || String(contact?.phone || '').replace(/\D/g, '') || String(context.phone || '').replace(/\D/g, '');
      let session = context.store ? findMatchingSession(context.store.sessions, targetDigits, name) : null;
      if (!session && context.session && context.session.phone !== OWNER_SELF_KEY) {
        const ctxDigits = String(context.session.phone || '').replace(/\D/g, '');
        if (!cleanPhone || ctxDigits === cleanPhone || (cleanPhone.length >= 8 && ctxDigits.endsWith(cleanPhone.slice(-8)))) {
          session = context.session;
        }
      }

      if (!contact && session) {
        contact = {
          name: session.clientName || session.pushName || 'Cliente',
          phone: session.phone || targetDigits || context.phone,
          labels: session.labels || [],
          notes: session.contactNotes || session.crmNotes || session.notes || '',
          customer_type: session.dealStage || 'lead'
        };
      }

      if (contact) {
        const attendance = buildAttendanceSummary(session);
        return {
          found: true,
          name: contact.name,
          phone: contact.phone,
          type: contact.customer_type || 'lead',
          labels: contact.labels || [],
          notes: contact.notes || 'Sem observações adicionais.',
          ...(attendance ? { attendance } : {})
        };
      }

      return {
        found: false,
        message: 'Contato ainda não possui cadastro formal no CRM nem sessão de atendimento registrada.'
      };
    } catch (err) {
      return { found: false, error: err.message };
    }
  }
};
