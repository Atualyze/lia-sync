import { normalizePhone, isValidRealMobilePhone } from '../sessions.mjs';

function normalizeName(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 100);
}

export const toolSalvarContato = {
  name: 'salvar_contato',
  description: 'Cadastra ou atualiza um contato externo no CRM/agenda da Lia pelo nome e telefone. Uso exclusivo do responsável; não envia mensagem.',
  parameters: {
    type: 'OBJECT',
    properties: {
      nome: {
        type: 'STRING',
        description: 'Nome do contato a cadastrar.'
      },
      telefone: {
        type: 'STRING',
        description: 'Telefone celular com DDD, com ou sem +55. Ex.: 8899845787 ou 558899845787.'
      }
    },
    required: ['nome', 'telefone']
  },
  async execute({ nome, telefone }, context = {}) {
    if (context.actor === 'client' || context.isOwner === false) {
      return { success: false, code: 'forbidden_for_client', error: 'O cadastro de contatos é exclusivo do responsável.' };
    }

    const name = normalizeName(nome);
    const rawPhone = String(telefone || '').trim();
    const phone = normalizePhone(rawPhone);

    if (name.length < 2) {
      return { success: false, code: 'invalid_contact_name', error: 'Informe um nome válido para o contato.' };
    }
    if (!isValidRealMobilePhone(phone)) {
      return { success: false, code: 'invalid_contact_phone', error: 'Informe um celular brasileiro válido com DDD.' };
    }

    const store = context.store;
    const client = store?.client;
    if (!client || client.enabled === false || typeof client.upsert !== 'function') {
      return { success: false, code: 'supabase_unavailable', error: 'Não consegui acessar o cadastro de contatos agora.' };
    }

    const payload = {
      channel: 'whatsapp',
      external_id: phone,
      phone,
      display_name: name,
      push_name: name,
      source: 'copilot',
      active: true,
      last_seen_at: new Date().toISOString()
    };

    try {
      const rows = await client.upsert('contacts', [payload], 'channel,external_id', { returnRepresentation: true });
      const contactId = rows?.[0]?.id || null;

      // Se já houver uma sessão local para esse número, mantém o nome disponível
      // imediatamente para resolução de destinatário, sem esperar novo sync remoto.
      if (store.sessions) {
        const normalizedDigits = phone.replace(/\D/g, '');
        for (const session of Object.values(store.sessions)) {
          const sessionDigits = String(session?.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
          if (sessionDigits && sessionDigits === normalizedDigits) {
            session.clientName = name;
            session.contactName = name;
            session.pushName = name;
            session.updatedAt = new Date().toISOString();
            store.markDirty?.();
            break;
          }
        }
      }

      return {
        success: true,
        code: 'contact_saved',
        id: contactId,
        name,
        phone,
        message: \`Contato \${name} salvo com sucesso.\`
      };
    } catch (error) {
      return { success: false, code: 'contact_save_failed', error: 'Não consegui salvar o contato agora: ' + error.message };
    }
  }
};
