import { normalizePhone, isValidRealMobilePhone, isTauanContact } from './sessions.mjs';

function hourAt(now, zone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', hour12: false }).format(new Date(now)));
}

export async function processMaintenance({
  store,
  send,
  notify,
  reminderStore,
  now = Date.now,
  timeZone = 'America/Sao_Paulo',
  staleHours = 12,
  humanReminderMinutes = 15,
  humanAutoResumeHours = 0,
  humanPhone = '',
  disableInactivityPings = true,
  enableLeadFollowUp = true,
  followUpMinHours = 24,
  followUpMaxHours = 72,
  logger = console
}) {
  const current = now();
  const hour = hourAt(current, timeZone);
  const daytime = hour >= 8 && hour < 20;

  // 1. Processar Lembretes Agendados do Tauan
  if (reminderStore) {
    const due = reminderStore.getPendingDue(current);
    for (const rem of due) {
      try {
        const clientInfo = rem.clientName ? `\n👤 *Contato:* ${rem.clientName} (${rem.phone})` : '';
        const alertMsg = `⏰ *Lembrete Agendado!*\n\n📋 *Tarefa:* ${rem.text}${clientInfo}`;
        reminderStore.markSent(rem.id);
        await notify?.(alertMsg);
      } catch (e) {
        logger.error?.('[maintenance] Erro ao disparar lembrete agendado:', e.message);
      }
    }
  }

  // 2. Processar Sessões e Inatividades
  for (const [key, session] of Object.entries(store.sessions)) {
    if (key.startsWith('sim:')) continue;
    if (key === 'tauan_self' || session.phone === 'tauan_self' || session.isInternalChat) continue;

    const rawPhone = session.phone || key;

    // NUNCA processar sessões do próprio Tauan / Chat Interno
    if (isTauanContact(rawPhone, humanPhone) || isTauanContact(key, humanPhone)) continue;

    // Validação estrita de celular real brasileiro:
    // NUNCA envia mensagem nem follow-up para números fictícios, aleatórios ou inválidos (ex: 9999-8888, 11111111)
    if (!isValidRealMobilePhone(rawPhone)) {
      continue;
    }

    // 2.0 Retomada de Turnos Adiados por Fora do Horário (Princípio "Adiar e não descartar")
    if (session.pendingTurnPostponedUntil && !session.human) {
      const resumeTime = new Date(session.pendingTurnPostponedUntil).getTime();
      if (current >= resumeTime) {
        session.pendingTurnPostponedUntil = null;
        session.pendingTurnPostponedAt = null;
        store.markDirty();

        try {
          const clientName = (session.clientName || session.contactName || '').trim();
          const cleanNum = String(session.phone).replace(/@.*$/, '').replace(/\D/g, '');
          await notify?.(`🌅 *Janela de Atendimento Iniciada!*\n\n*${clientName || 'Contato'}* (${cleanNum}) enviou mensagem fora do expediente e aguarda retorno.\n📱 https://wa.me/${cleanNum}`);
        } catch (e) {
          logger.error?.('[maintenance] Erro ao notificar reabertura de expediente:', e.message);
        }
      }
    }

    // 2.1 Auto-retomada se configurado
    if (session.human && humanAutoResumeHours > 0 && session.handoffAt && current - new Date(session.handoffAt).getTime() >= humanAutoResumeHours * 3600000) {
      session.human = false;
      session.humanSource = 'auto-resume';
      session.handoffReminderAt = null;
      store.markDirty();
      continue;
    }

    // 2.2 Lembrete único para o Tauan de cliente aguardando atendimento
    const isTakeover = session.humanSource === 'takeover' || Boolean(session.takeoverAt);
    if (session.human && session.handoffAt && !session.handoffReminder1Sent && !isTakeover) {
      const elapsedMin = (current - new Date(session.handoffAt).getTime()) / 60000;
      if (elapsedMin >= humanReminderMinutes) {
        session.handoffReminder1Sent = true;
        session.handoffReminderSentAt = new Date(current).toISOString();
        store.markDirty();

        try {
          const name = session.clientName || session.contactName || session.phone;
          const cleanNum = String(session.phone).replace(/@.*$/, '').replace(/\D/g, '');
          const link = cleanNum ? `\n📱 https://wa.me/${cleanNum}` : '';
          await notify?.(`⏰ *Lembrete de Atendimento:*\n\n*${name}* ainda aguarda seu retorno no WhatsApp.${link}`);
        } catch (e) {
          logger.error?.('[maintenance] Erro ao enviar lembrete de atendimento:', e.message);
        }
      }
    }

    // 2.3 Tratamento de inatividade do cliente
    if (session.human || !session.lastBotAt) continue;

    const elapsed = current - new Date(session.lastBotAt).getTime();

    // 2.3 Follow-up Ativo e Proativo de Leads (Reengajamento inteligente após 24h a 72h)
    // Apenas para leads reais comprovados, com mensagens reais trocadas e telefone móvel verificado
    if (enableLeadFollowUp && daytime) {
      const elapsedHours = elapsed / 3600000;
      const isWithinWindow = elapsedHours >= followUpMinHours && elapsedHours <= followUpMaxHours;
      const hasNotFollowedUp = !session.followUpSentAt && (session.followUpCount || 0) === 0;

      // Exige histórico real de diálogo onde o usuário enviou mensagem com conteúdo legível
      const hasRealUserMessage = Array.isArray(session.history) && session.history.some(
        (m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim().length >= 3 && !/^\s*\{|"simulado"|"teste"|Carlos!/i.test(m.content)
      );
      const hasMeaningfulHistory = Array.isArray(session.history) && session.history.length >= 2;

      // Não enviar se o cliente estiver em atendimento humano ou se já tiver recebido follow-up
      if (!session.human && hasNotFollowedUp && isWithinWindow && hasMeaningfulHistory && hasRealUserMessage) {
        session.followUpCount = 1;
        session.followUpSentAt = new Date(current).toISOString();

        const clientName = (session.clientName || session.contactName || '').trim();
        const greeting = clientName ? `Oi, ${clientName}!` : 'Oi!';
        const followUpMessage = `${greeting} Tudo bem por aí? 😊\n\nPassando rapidinho só para saber se você conseguiu ver as informações ou se ficou com alguma dúvida sobre o que conversamos. Se quiser continuar por aqui ou falar direto com o *Tauan*, fico à disposição! ✨`;

        session.history.push({ role: 'assistant', content: followUpMessage, createdAt: new Date(current).toISOString() });
        store.markDirty();

        try {
          await send?.(session.phone, followUpMessage);
        } catch (e) {
          logger.error?.('[maintenance] Erro ao enviar follow-up de reengajamento:', e.message);
        }
        continue;
      }
    }

    // 2.4 Se passou do limite de inatividade (staleHours), encerra a sessão silenciosamente
    if (elapsed > staleHours * 3600000) {
      if (!session.inactivityClosed) {
        session.inactivityClosed = true;
        session.awaitingReply = false;
        store.markDirty();
      }
      continue;
    }

    // Se pings de inatividade estiverem desativados (padrão), não envia cobranças repetitivas
    if (disableInactivityPings) continue;

    // Se explicitamente habilitado nas configs, envia pings apenas em horário comercial
    if (!session.awaitingReply || !daytime) continue;

    const stage = elapsed >= 20 * 60000 ? 3 : elapsed >= 10 * 60000 ? 2 : elapsed >= 5 * 60000 ? 1 : 0;
    if (!stage || stage <= (session.inactivityStage || 0)) continue;

    const message = stage === 1
      ? 'Oi! Passando só pra ver se você ainda precisa de alguma ajuda por aqui. 😊\n\nFique à vontade pra responder quando puder!'
      : stage === 2
      ? 'Oi de novo! 👋\n\nCaso queira continuar depois ou falar direto com o *Tauan*, é só me mandar uma mensagem aqui.'
      : 'Como não tive retorno, vou pausar nosso atendimento por agora. ⏸️\n\nQuando quiser continuar, é só me mandar um *oi*!';

    session.inactivityStage = stage;
    if (stage === 3) {
      session.inactivityClosed = true;
      session.awaitingReply = false;
    }
    store.markDirty();

    try {
      await send?.(session.phone, message);
      session.history = [...(session.history || []), { role: 'assistant', content: message }].slice(-12);
      store.markDirty();
    } catch (e) {
      logger.error?.('[maintenance] Erro ao enviar ping de inatividade:', e.message);
    }
  }

  await store.flush?.();
}
