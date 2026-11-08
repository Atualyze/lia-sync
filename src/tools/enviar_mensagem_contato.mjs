import { sendText, sendWhatsAppAudio } from '../whatsapp.mjs';

/**
 * Tool: enviar_mensagem_contato
 * Permite à Lia disparar uma mensagem ativa de WhatsApp para um contato externo sob comando do Tauan.
 */
export const toolEnviarMensagemContato = {
  name: 'enviar_mensagem_contato',
  description: 'Envia ou dispara uma mensagem de WhatsApp ativa para um cliente ou contato externo sob o comando do Tauan. Recebe o telefone (com DDD) ou o nome do contato cadastrado na agenda/CRM para localização automática.',
  parameters: {
    type: 'OBJECT',
    properties: {
      recipient: {
        type: 'STRING',
        description: 'Número de telefone com DDD (apenas dígitos, ex: 55889921538106, 88992153810) ou nome do contato cadastrado no CRM/agenda (ex: "Roniel", "Foxline", "Rodrigo Mesquita", "Emanuelle", "Lima").'
      },
      message: {
        type: 'STRING',
        description: 'Texto exato e completo da mensagem que será disparada para o contato no WhatsApp.'
      },
      asAudio: {
        type: 'BOOLEAN',
        description: 'Se true, sintetiza o texto em áudio realista com a voz da Lia e envia como mensagem de voz no WhatsApp.'
      }
    },
    required: ['message']
  },
  async execute({ recipient, message, asAudio }, context = {}) {
    let rawRec = String(recipient || '').trim();
    const cleanMsg = String(message || '').trim();

    // Se destinatário não veio no arg, tenta resolver pelo estado pendente ou histórico recente
    if (!rawRec) {
      if (context.session?.pendingRecipient) {
        rawRec = String(context.session.pendingRecipient).trim();
      } else if (context.session?.history && context.store?.sessions) {
        const recentTexts = context.session.history.slice(-4).map(h => h.content).join(' ');
        for (const [phone, s] of Object.entries(context.store.sessions)) {
          if (phone === 'tauan_self' || !s.phone) continue;
          const name = s.clientName || s.pushName || s.contactName || '';
          if (name && name.length >= 3) {
            const regex = new RegExp('\\b' + name.trim() + '\\b', 'i');
            if (regex.test(recentTexts)) {
              rawRec = name;
              break;
            }
          }
        }
      }
    }

    if (!rawRec) {
      return { success: false, error: 'Por favor, informe para qual contato ou telefone deseja enviar.' };
    }

    if (!cleanMsg) {
      return { success: false, error: 'Por favor, informe o conteúdo da mensagem que deseja enviar para ' + rawRec + '.' };
    }

    let targetPhone = '';
    let targetName = '';

    const digits = rawRec.replace(/\D/g, '');

    // Se tiver 8 ou mais dígitos, trata diretamente como telefone
    if (digits.length >= 8) {
      if (digits.startsWith('55')) {
        targetPhone = digits;
      } else if (digits.length === 10 || digits.length === 11) {
        targetPhone = '55' + digits;
      } else {
        targetPhone = digits;
      }
      targetName = rawRec;
    }

    // Se for nome ou se precisamos resolver o nome para telefone
    const store = context.store;
    if (store && (!targetPhone || digits.length < 8)) {
      const recLower = rawRec.toLowerCase();
      const sessions = Object.values(store.sessions || {});
      for (const s of sessions) {
        if (!s || !s.phone || s.phone === 'tauan_self') continue;
        const name = (s.clientName || s.pushName || s.contactName || '').toLowerCase();
        if (name && (name.includes(recLower) || recLower.includes(name))) {
          targetPhone = String(s.phone).replace(/@.*$/, '').replace(/\D/g, '');
          targetName = s.clientName || s.pushName || s.contactName || targetPhone;
          break;
        }
      }
    }

    // Se ainda não encontrou e temos Supabase no client do store
    if (!targetPhone && store?.client?.from) {
      try {
        const { data } = await store.client
          .from('contacts')
          .select('phone, name, display_name, push_name')
          .ilike('name', '%' + rawRec + '%')
          .limit(1);
        if (data && data[0]?.phone) {
          targetPhone = String(data[0].phone).replace(/\D/g, '');
          targetName = data[0].name || data[0].display_name || targetPhone;
        }
      } catch (err) {
        // ignora
      }
    }

    if (!targetPhone || targetPhone.length < 8) {
      return {
        success: false,
        error: 'Não foi possível localizar o telefone para "' + rawRec + '". Por favor informe o número com DDD para o envio.'
      };
    }

    // Normaliza para DDI 55
    if (!targetPhone.startsWith('55') && (targetPhone.length === 10 || targetPhone.length === 11)) {
      targetPhone = '55' + targetPhone;
    }

    // Dispara via whatsapp.mjs (Evolution API)
    try {
      let isVoice = asAudio === true;
      if (isVoice) {
        try {
          const synthFn = context.ai?.synthesizeVoice;
          const sendAudioFn = context.whatsapp?.sendWhatsAppAudio || sendWhatsAppAudio;
          if (synthFn && sendAudioFn) {
            const voiceRes = await synthFn(cleanMsg, { botConfig: context.botConfig });
            if (voiceRes?.base64) {
              await sendAudioFn(targetPhone, voiceRes.base64);
            } else {
              const sendFn = context.whatsapp?.sendText || sendText;
              await sendFn(targetPhone, cleanMsg);
              isVoice = false;
            }
          } else {
            const sendFn = context.whatsapp?.sendText || sendText;
            await sendFn(targetPhone, cleanMsg);
            isVoice = false;
          }
        } catch (e) {
          console.error('[tool:enviar_mensagem_contato] Falha no envio em áudio, enviando texto:', e.message);
          const sendFn = context.whatsapp?.sendText || sendText;
          await sendFn(targetPhone, cleanMsg);
          isVoice = false;
        }
      } else {
        const sendFn = context.whatsapp?.sendText || sendText;
        await sendFn(targetPhone, cleanMsg);
      }

      // Registra no histórico do contato
      if (store?.get) {
        const sTarget = store.get(targetPhone);
        if (sTarget) {
          sTarget.history = sTarget.history || [];
          sTarget.history.push({
            role: 'assistant',
            content: cleanMsg,
            createdAt: new Date().toISOString(),
            fromCopilot: true
          });
          store.touch?.(sTarget);
          store.markDirty?.();
          await store.flush?.().catch(() => {});
        }
      }

      // Limpa pendingRecipient da sessão do Copiloto após sucesso
      if (context.session) {
        context.session.pendingRecipient = null;
      }

      return {
        success: true,
        sent: true,
        asAudio: isVoice,
        recipient: targetName || targetPhone,
        phone: targetPhone,
        message: cleanMsg
      };
    } catch (err) {
      return {
        success: false,
        error: 'Falha ao enviar mensagem no WhatsApp para ' + targetPhone + ': ' + err.message
      };
    }
  }
};
