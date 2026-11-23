import { normalizePhone, isValidRealMobilePhone, isOwnerContact } from './sessions.mjs';
import { isOwnerKey, resolveIdentity } from './core/identity.mjs';
import { checkInfinitePayPayment } from './tools/gerenciar_cobranca_pagamento.mjs';
import { filterReply } from './safety.mjs';
import { getAllowedPrices } from './faq.mjs';
import { isHumanHandoffActive } from './flow/human-handoff-state.mjs';

const followUpLocks = new WeakMap();

function hourAt(now, zone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', hour12: false }).format(new Date(now)));
}

export async function processMaintenance({
  store,
  send,
  stageOutboundDispatch,
  notify,
  reminderStore,
  checkPayment = checkInfinitePayPayment,
  now = Date.now,
  timeZone = 'America/Sao_Paulo',
  staleHours = 12,
  humanReminderMinutes = 15,
  humanPhone = '',
  activeInstancePhone = '',
  disableInactivityPings = false,
  enableLeadFollowUp = true,
  followUpMinHours = 24,
  followUpMaxHours = 72,
  autoResumeOnOpen = true,
  onPostponedResume = null,
  identity = {},
  logger = console
}) {
  const current = now();
  const resolvedIdentity = resolveIdentity(identity);
  const owner = resolvedIdentity.responsible || 'nossa equipe';
  const expiredSessions = store.purge?.() || 0;
  if (expiredSessions) store.markDirty?.();
  try { await store.purgeArchives?.(); } catch (e) { logger.warn?.('[maintenance] Falha ao aplicar retenção de archives:', e.message); }
  const hour = hourAt(current, timeZone);
  const daytime = hour >= 8 && hour < 20;

  // 1. Processar Lembretes Agendados do responsável
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
    if (isOwnerKey(key) || isOwnerKey(session.phone) || session.isInternalChat) continue;

    const rawPhone = session.phone || key;

    // NUNCA processar sessões do próprio responsável / Chat Interno
    if (isOwnerContact(rawPhone, { humanPhone, identity: resolvedIdentity }) || isOwnerContact(key, { humanPhone, identity: resolvedIdentity })) continue;

    // Validação estrita de celular real brasileiro:
    // NUNCA envia mensagem nem follow-up para números fictícios, aleatórios ou inválidos (ex: 9999-8888, 11111111)
    if (!isValidRealMobilePhone(rawPhone)) {
      continue;
    }

    // 2.0 Retomada de Turnos Adiados por Fora do Horário (Princípio "Adiar e não descartar")
    const normActiveInstance = activeInstancePhone ? normalizePhone(activeInstancePhone) : '';
    const normSessionInstance = session.instancePhone ? normalizePhone(session.instancePhone) : '';
    if (normActiveInstance && normSessionInstance && normSessionInstance !== normActiveInstance) {
      continue;
    }
    if (session.pendingTurnPostponedUntil && !isHumanHandoffActive(session)) {
      const resumeTime = new Date(session.pendingTurnPostponedUntil).getTime();
      if (current >= resumeTime) {
        session.pendingTurnPostponedUntil = null;
        session.pendingTurnPostponedAt = null;
        store.markDirty();

        const clientName = (session.clientName || session.contactName || '').trim();
        const cleanNum = String(session.phone).replace(/@.*$/, '').replace(/\D/g, '');
        let autoResumed = false;
        if (autoResumeOnOpen && typeof onPostponedResume === 'function') {
          try {
            const res = await onPostponedResume(session);
            autoResumed = Boolean(res?.continued);
          } catch (e) {
            logger.error?.('[maintenance] Erro na retomada automática na abertura do expediente:', e.message);
          }
        }
        try {
          if (autoResumed) {
            await notify?.(`🌅 *Expediente Iniciado — Retomada Automática!*\n\nJá retomei e respondi *${clientName || 'Contato'}* (${cleanNum}) sobre a mensagem deixada fora do expediente.`);
          } else {
            await notify?.(`🌅 *Janela de Atendimento Iniciada!*\n\n*${clientName || 'Contato'}* (${cleanNum}) enviou mensagem fora do expediente e aguarda retorno.\n📱 https://wa.me/${cleanNum}`);
          }
        } catch (e) {
          logger.error?.('[maintenance] Erro ao notificar reabertura de expediente:', e.message);
        }
      }
    }

    // 2.2 Lembrete único para o responsável de cliente aguardando atendimento
    const isTakeover = session.humanSource === 'takeover' || Boolean(session.takeoverAt);
    if (isHumanHandoffActive(session) && session.handoffAt && !session.handoffReminder1Sent && !isTakeover) {
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
    if (isHumanHandoffActive(session) || !session.lastBotAt) continue;

    const elapsed = current - new Date(session.lastBotAt).getTime();

    // 2.3 Follow-up Ativo e Proativo de Leads (Reengajamento inteligente após 24h a 72h)
    // Apenas para leads reais, com mensagens reais trocadas e telefone móvel brasileiro válido (formato)
    if (enableLeadFollowUp && daytime) {
      const elapsedHours = elapsed / 3600000;
      const isWithinWindow = elapsedHours >= followUpMinHours && elapsedHours <= followUpMaxHours;
      const lastUserAt = new Date(session.lastUserAt || 0).getTime();
      const lastBotAt = new Date(session.lastBotAt || 0).getTime();
      const noNewUserMessage = Number.isFinite(lastUserAt) && Number.isFinite(lastBotAt) && lastUserAt > 0 && lastUserAt <= lastBotAt;
      const hasNotFollowedUp = !session.followUpSentAt && !session.followUpClaimedAt && (session.followUpCount || 0) === 0;

      // Exige histórico real de diálogo onde o usuário enviou mensagem com conteúdo legível
      const hasRealUserMessage = Array.isArray(session.history) && session.history.some(
        (m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim().length >= 3 && !/^\s*\{|"simulado"|"teste"|Carlos!/i.test(m.content)
      );
      const hasMeaningfulHistory = Array.isArray(session.history) && session.history.length >= 2;

      // Não enviar se o cliente estiver em atendimento humano ou se já tiver recebido follow-up
      if (!isHumanHandoffActive(session) && noNewUserMessage && hasNotFollowedUp && isWithinWindow && hasMeaningfulHistory && hasRealUserMessage) {
        let locks = followUpLocks.get(store);
        if (!locks) { locks = new Set(); followUpLocks.set(store, locks); }
        if (locks.has(key)) continue;
        locks.add(key);
        const claimAt = new Date(current).toISOString();

        const clientName = (session.clientName || session.contactName || '').trim();
        const greeting = clientName ? `Oi, ${clientName}!` : 'Oi!';
        const userQuotes = session.history.filter(m => m && m.role === 'user' && typeof m.content === 'string').map(m => m.content.toLowerCase()).join(' ');
        const isCommercialProposal = /(?:preço|preco|valor|quanto|orçamento|orcamento|proposta|plano|pacote|custo|fechar|contratar)\b/i.test(userQuotes);
        const followUpMessage = isCommercialProposal
          ? `${greeting} Tudo bem por aí? 😊\n\nPassando rapidinho só para saber se você conseguiu avaliar a proposta ou se ficou com alguma dúvida sobre valores e prazos. Se quiser ajustar algo no projeto ou falar direto com *${owner}*, fico à disposição! ✨`
          : `${greeting} Tudo bem por aí? 😊\n\nPassando rapidinho só para saber se você conseguiu ver as informações ou se ficou com alguma dúvida sobre o que conversamos. Se quiser continuar por aqui ou falar direto com *${owner}*, fico à disposição! ✨`;

        try {
          if (typeof stageOutboundDispatch !== 'function') throw new Error('copilot_confirmation_gate_unavailable');
          const followUpFiltered = filterReply(followUpMessage, { allowedPrices: getAllowedPrices(), strictPrices: true });
          const safeFollowUpMessage = followUpFiltered.blocked || !followUpFiltered.text
            ? `${greeting} Passando para saber se ficou alguma dúvida sobre o que conversamos. Se quiser continuar por aqui ou falar com *${owner}*, fico à disposição!`
            : followUpFiltered.text;
          const pending = await stageOutboundDispatch({
            phone: session.phone,
            recipient: clientName || session.phone,
            message: safeFollowUpMessage
          }, { source: 'maintenance-follow-up', metadata: { sourceRef: key } });
          if (pending) {
            session.followUpCount = 1;
            session.followUpClaimedAt = claimAt;
            session.followUpClaimToken = null;
            session.followUpPendingId = pending.id;
            store.markDirty();
            await store.flush?.();
          }
        } catch (e) {
          logger.error?.('[maintenance] Não foi possível criar prévia do follow-up:', e.message);
        } finally {
          locks.delete(key);
        }
        continue;
      }
    }

    // 2.3b Recuperação automática de Checkout / Pix pendente (após 45 min, dentro de 24h, em horário diurno)
    if (
      !isHumanHandoffActive(session) &&
      daytime &&
      session.pendingCheckout &&
      !session.pendingCheckout.paidAt &&
      !session.pendingCheckout.recoverySentAt &&
      !session.pendingCheckout.recoveryPendingId &&
      session.pendingCheckout.checkoutUrl
    ) {
      const checkoutCreatedMs = new Date(session.pendingCheckout.createdAt || 0).getTime();
      const checkoutElapsed = Number.isFinite(checkoutCreatedMs) && checkoutCreatedMs > 0 ? current - checkoutCreatedMs : 0;
      if (checkoutElapsed >= 45 * 60000 && checkoutElapsed <= 24 * 3600000) {
        let alreadyPaid = false;
        if (session.pendingCheckout.handle && session.pendingCheckout.orderNsu) {
          try {
            const payStatus = await checkPayment?.({
              handle: session.pendingCheckout.handle,
              orderNsu: session.pendingCheckout.orderNsu
            });
            const expectedCents = Number(session.pendingCheckout.amountCents) || 0;
            const confirmedCents = Number(payStatus?.paidAmount || payStatus?.amount || 0);
            const amountMatches = expectedCents > 0 && confirmedCents > 0
              ? expectedCents === confirmedCents
              : expectedCents === 0;
            if (payStatus?.paid && amountMatches) {
              alreadyPaid = true;
              session.pendingCheckout.paidAt = new Date(current).toISOString();
              session.tags = Array.from(new Set([...(Array.isArray(session.tags) ? session.tags : []).filter((t) => t !== 'checkout-pendente'), 'pagamento-confirmado'])).slice(0, 20);
              store.markDirty();
            } else if (payStatus?.paid && !amountMatches) {
              logger.warn?.(`[maintenance] Pagamento divergente para ${session.pendingCheckout.orderNsu}: esperado=${expectedCents}, recebido=${confirmedCents}.`);
            }
          } catch (e) {
            logger.warn?.('[maintenance] Falha ao checar pagamento InfinitePay antes da recuperação:', e.message);
          }
        }
        if (!alreadyPaid) {
          const amountCents = Number(session.pendingCheckout.amountCents) || 0;
          const valorFmt = amountCents
            ? ` de *R$ ${(amountCents / 100).toFixed(2).replace('.', ',')}*`
            : '';
          const recMsgRaw = `Oi! Passando só para lembrar que seu link de pagamento${valorFmt} ainda está disponível caso queira concluir:\n\n${session.pendingCheckout.checkoutUrl}\n\nSe já tiver pago ou precisar de alguma ajuda, é só me avisar por aqui! 😊`;
          // O valor do próprio checkout é permitido por definição; nada além dele passa.
          const recFiltered = filterReply(recMsgRaw, {
            allowedPrices: new Set([
              ...(amountCents ? [(amountCents / 100).toFixed(2), String(amountCents / 100).replace('.', ',')] : []),
              ...getAllowedPrices()
            ]),
            strictPrices: true
          });
          const recMsg = recFiltered.blocked || !recFiltered.text ? '' : recFiltered.text;
          try {
            if (!recMsg) throw new Error('checkout_recovery_blocked_by_filter');
            if (typeof stageOutboundDispatch !== 'function') throw new Error('copilot_confirmation_gate_unavailable');
            const pending = await stageOutboundDispatch({
              phone: session.phone,
              recipient: session.clientName || session.contactName || session.phone,
              message: recMsg
            }, { source: 'maintenance-checkout', metadata: { sourceRef: key } });
            if (pending) {
              session.pendingCheckout.recoveryPendingId = pending.id;
              store.markDirty();
              await store.flush?.();
            }
          } catch (e) {
            logger.error?.('[maintenance] Não foi possível criar prévia de recuperação de checkout:', e.message);
          }
          continue;
        }
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
      ? 'Oi! Passando só pra ver se você ainda precisa de alguma ajuda por aqui. Fico à disposição para qualquer dúvida! 😊\n\nFique à vontade pra responder quando puder!'
      : stage === 2
      ? 'Oi de novo! 👋\n\nCaso queira continuar depois ou falar direto com *' + owner + '*, é só me mandar uma mensagem aqui.'
      : 'Como não tive retorno, vou pausar nosso atendimento por agora. ⏸️\n\nQuando quiser continuar, é só me mandar um *oi*!';

    try {
      if (typeof stageOutboundDispatch !== 'function') throw new Error('copilot_confirmation_gate_unavailable');
      await stageOutboundDispatch({
        phone: session.phone,
        recipient: session.clientName || session.contactName || session.phone,
        message
      }, { source: 'maintenance-inactivity', metadata: { sourceRef: key, inactivityStage: stage } });
    } catch (e) {
      logger.error?.('[maintenance] Não foi possível criar prévia do ping de inatividade:', e.message);
    }
  }

  await store.flush?.();
}
