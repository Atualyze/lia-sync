import { sendText, sendWhatsAppAudio } from '../whatsapp.mjs';
import { isOwnerKey } from '../core/identity.mjs';
import { filterReply, normalize } from '../safety.mjs';
import { getAllowedPrices } from '../faq.mjs';

/**
 * Tool: enviar_mensagem_contato
 * Permite à assistente disparar uma mensagem ativa de WhatsApp para um contato externo sob comando do responsável.
 */
export const toolEnviarMensagemContato = {
  name: 'enviar_mensagem_contato',
  description: 'Envia ou dispara uma mensagem de WhatsApp ativa para um cliente ou contato externo sob o comando do responsável. Recebe o telefone (com DDD) ou o nome do contato cadastrado na agenda/CRM para localização automática.',
  parameters: {
    type: 'OBJECT',
    properties: {
      recipient: {
        type: 'STRING',
        description: 'Número de telefone com DDD (apenas dígitos, ex: 5511999998888) ou nome do contato cadastrado no CRM/agenda (ex: "Roniel", "Foxline", "Rodrigo Mesquita", "Lima").'
      },
      message: {
        type: 'STRING',
        description: 'Texto exato e completo da mensagem que será disparada para o contato no WhatsApp.'
      },
      asAudio: {
        type: 'BOOLEAN',
        description: 'Se true, sintetiza o texto em áudio realista com a voz da assistente e envia como mensagem de voz no WhatsApp.'
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
          if (isOwnerKey(phone) || !s.phone) continue;
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

    // Nenhum texto gerado sai sem o filtro de segurança: preço não confirmado bloqueia o envio.
    const filtered = filterReply(cleanMsg, {
      allowedPrices: getAllowedPrices(),
      isCopilot: isOwnerKey(context.phone),
      strictPrices: true
    });
    if (filtered.blocked) {
      return {
        success: false,
        error: 'A mensagem tem conteúdo que não pode ser enviado com segurança (valor ou informação não confirmada). Ajuste o texto e tente novamente.'
      };
    }
    const safeMsg = filtered.text || cleanMsg;

    let targetPhone = '';
    let targetName = '';
    const wantedName = normalize(rawRec);

    // Chaves de simulação nunca viram telefone real.
    if (/^sim:/i.test(rawRec)) {
      return { success: false, error: 'Contatos de simulação não recebem mensagens reais. Informe o número do contato.' };
    }

    const isLid = /@lid$/i.test(rawRec);
    const digits = rawRec.replace(/\D/g, '');

    if (isLid) {
      // JID real do WhatsApp: preservar o identificador completo para o envio.
      targetPhone = rawRec;
      targetName = rawRec;
    } else if (digits.length >= 8) {
      // Se tiver 8 ou mais dígitos, trata diretamente como telefone
      if (digits.startsWith('55')) {
        targetPhone = digits;
      } else if (digits.length === 10 || digits.length === 11) {
        targetPhone = '55' + digits;
      } else {
        targetPhone = digits;
      }
      targetName = rawRec;
    }

    // Resolução por nome: apenas match exato normalizado, em sessões de cliente reais.
    const store = context.store;
    if (!targetPhone && store && wantedName) {
      const candidates = new Map();
      for (const [key, s] of Object.entries(store.sessions || {})) {
        if (!s || !s.phone) continue;
        const keyText = String(key);
        const phoneText = String(s.phone);
        if (keyText.startsWith('sim:') || phoneText.startsWith('sim:') || s.origin === 'simulation') continue;
        if (/@lid$/i.test(keyText) || /@lid$/i.test(phoneText)) continue;
        if (isOwnerKey(keyText) || isOwnerKey(phoneText)) continue;
        const name = normalize(s.clientName || s.pushName || s.contactName || '');
        if (!name || name !== wantedName) continue;
        const phoneDigits = phoneText.replace(/@.*$/, '').replace(/\D/g, '');
        if (phoneDigits.length < 8) continue;
        if (!candidates.has(phoneDigits)) candidates.set(phoneDigits, s);
      }
      if (candidates.size > 1) {
        return { success: false, error: `Encontrei mais de um contato com o nome "${rawRec}". Por favor informe o número com DDD para o envio.` };
      }
      if (candidates.size === 1) {
        const [phoneDigits, session] = candidates.entries().next().value;
        targetPhone = phoneDigits;
        targetName = session.clientName || session.pushName || session.contactName || phoneDigits;
      }
    }

    // Fallback remoto no CRM: também exige nome exato (sem substring).
    if (!targetPhone && store?.client && wantedName) {
      try {
        let rows = [];
        if (typeof store.client.select === 'function' && store.client.enabled !== false) {
          rows = await store.client.select(
            'contacts',
            'select=phone,display_name,push_name&limit=5'
          ) || [];
        }
        if (!rows.length && typeof store.client.from === 'function') {
          const { data } = await store.client
            .from('contacts')
            .select('phone, name, display_name, push_name')
            .limit(5);
          rows = data || [];
        }
        const matched = rows.filter(row => [row?.display_name, row?.push_name, row?.name]
          .some(name => normalize(name) === wantedName));
        const phones = new Set(matched.map(row => String(row.phone || '').replace(/\D/g, '')).filter(p => p.length >= 8));
        if (phones.size > 1) {
          return { success: false, error: `Encontrei mais de um contato com o nome "${rawRec}". Por favor informe o número com DDD para o envio.` };
        }
        if (phones.size === 1) {
          const [phoneDigits] = phones;
          const row = matched.find(item => String(item.phone || '').replace(/\D/g, '') === phoneDigits);
          targetPhone = phoneDigits;
          targetName = row?.display_name || row?.push_name || row?.name || phoneDigits;
        }
      } catch (err) {
        // ignora: sem CRM disponível, segue para a validação abaixo
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
        const synthFn = context.ai?.synthesizeVoice;
        const sendAudioFn = context.whatsapp?.sendWhatsAppAudio || sendWhatsAppAudio;
        let voiceRes = null;
        if (synthFn && sendAudioFn) {
          try { voiceRes = await synthFn(cleanMsg, { botConfig: context.botConfig }); }
          catch (e) { console.error('[tool:enviar_mensagem_contato] Falha na síntese de áudio:', e.code || e.name || 'tts_failed'); }
        }
        if (voiceRes?.base64) {
          try {
            await sendAudioFn(targetPhone, voiceRes.base64);
            const sendTranscription = context.botConfig?.voice?.sendTranscriptionWithAudio !== false && context.botConfig?.voice?.deliveryMode !== 'audio_only';
            if (sendTranscription) {
              const sendFn = context.whatsapp?.sendText || context.whatsapp?.sendWhatsAppText || sendText;
              await sendFn(targetPhone, cleanMsg);
            }
          }
          catch (e) {
            return { success: false, deliveryUnknown: e?.deliveryUnknown === true, error: e?.deliveryUnknown ? 'O resultado da entrega de áudio é incerto; não foi feito retry nem fallback para texto.' : 'A Evolution recusou a entrega do áudio; o texto não foi enviado automaticamente.' };
          }
        } else {
          const sendFn = context.whatsapp?.sendText || context.whatsapp?.sendWhatsAppText || sendText;
          await sendFn(targetPhone, cleanMsg);
          isVoice = false;
        }
      } else {
        const sendFn = context.whatsapp?.sendText || context.whatsapp?.sendWhatsAppText || sendText;
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
