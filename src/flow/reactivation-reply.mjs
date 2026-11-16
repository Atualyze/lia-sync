import { buildSystemPrompt } from '../knowledge.mjs';
import { filterReply } from '../safety.mjs';
import { formatOutgoingMessage } from '../core/format.mjs';

const PENDING_TTL_MS = 30 * 60 * 1000;

/**
 * Trata a resposta do admin no chat interno quando há uma reativação pendente,
 * decidindo automaticamente entre manter modo humano, concluir o atendimento
 * ou retomar com o cliente enviando uma resposta contextualizada.
 */
export async function handlePendingReactivationReply({
  store, ai, whatsapp, botConfig, sSelf, cleanCommand, findSessionByTarget, now, owner
}) {
  const pending = sSelf?.pendingReactivation;
  if (!pending || !pending.phone) return null;

  const createdMs = Date.parse(pending.createdAt || '');
  if (Number.isFinite(createdMs) && now() - createdMs > PENDING_TTL_MS) {
    sSelf.pendingReactivation = null;
    store.markDirty?.();
    return null;
  }

  const cmd = String(cleanCommand || '').trim();
  if (!cmd) return null;

  const wantsHuman = /\b(eu\s+resolv|eu\s+mesm|deixa\s+comigo|mant[eé]m\s+no\s+humano|fica\s+no\s+humano|modo\s+humano|eu\s+atendo|vou\s+responder|assum[eo])\b/i.test(cmd);
  const wantsClose = /\b(j[aá]\s+resolv|pode\s+encerrar|encerr[ae]|conclu[ií]|finaliz[ae]|j[aá]\s+atendi|tudo\s+resolvido)\b/i.test(cmd);
  const wantsBotContinue = /\b(pode\s+(?:continuar|responder|seguir|assumir|dar\s+continuidade)|segue\s+(?:a[ií]|com)|responde\s+(?:ele|ela|o\s+cliente)|vai\s+l[aá]|sim\b|pode\s+sim)\b/i.test(cmd);

  if (!wantsHuman && !wantsClose && !wantsBotContinue) return null;

  const sTarget = store.get?.(pending.phone) || findSessionByTarget?.(pending.phone);
  sSelf.pendingReactivation = null;
  if (!sTarget) {
    store.markDirty?.();
    return `Não localizei mais a sessão de *${pending.contactLabel || pending.phone}* para aplicar a ação.`;
  }

  const nowIso = new Date(now()).toISOString();

  if (wantsHuman) {
    sTarget.human = true;
    sTarget.humanSource = 'admin';
    sTarget.handoffAt = nowIso;
    sTarget.handoffReason = `mantido no modo humano por ${owner || 'admin'} após reativação`;
    sTarget.inactivityClosed = false;
    sTarget.updatedAt = nowIso;
    store.markDirty?.();
    await store.flush?.();
    return `Combinado! Mantive *${pending.contactLabel}* no **modo humano** aguardando você.`;
  }

  if (wantsClose) {
    sTarget.human = false;
    sTarget.humanSource = null;
    sTarget.handoffAt = null;
    sTarget.inactivityClosed = true;
    sTarget.updatedAt = nowIso;
    store.markDirty?.();
    await store.flush?.();
    return `Perfeito! Concluí e encerrei o atendimento de *${pending.contactLabel}*.`;
  }

  // wantsBotContinue: Lia retoma e envia resposta natural ao cliente
  sTarget.human = false;
  sTarget.humanSource = null;
  sTarget.handoffAt = null;
  sTarget.inactivityClosed = false;
  sTarget.updatedAt = nowIso;

  const targetJid = sTarget.jid || `${String(pending.phone).replace(/\D/g, '')}@s.whatsapp.net`;
  const sys = buildSystemPrompt({
    session: sTarget,
    now: new Date(now()),
    botConfig,
    isOwner: false
  });
  const continuationPrompt = pending.unanswered
    ? `O atendimento humano devolveu esta conversa para você. A última mensagem do cliente ficou sem resposta ("${pending.snippet || ''}"). Responda de forma natural e acolhedora dando continuidade à qualificação e dúvidas.`
    : `O atendimento humano devolveu esta conversa para você após já ter respondido ao cliente. Envie uma mensagem curta, natural e simpática perguntando se ficou alguma dúvida ou se podem seguir com o atendimento.`;

  const aiResult = await ai?.askAI?.({
    system: sys,
    history: Array.isArray(sTarget.history) ? sTarget.history.slice(-16) : [],
    userText: continuationPrompt,
    botConfig,
    isOwner: false
  }).catch(() => null);

  const rawReply = aiResult?.text || aiResult?.reply || 'Oi! Passando por aqui para saber se ficou alguma dúvida ou se posso te ajudar a continuar seu atendimento por aqui.';
  const finalReply = formatOutgoingMessage(filterReply(rawReply).text || rawReply);

  if (whatsapp?.sendText) {
    await whatsapp.sendText(targetJid, finalReply);
  }
  sTarget.history ??= [];
  sTarget.history.push({ role: 'model', text: finalReply, createdAt: nowIso });
  sTarget.lastBotAt = nowIso;
  store.markDirty?.();
  await store.flush?.();

  return `Pronto! Retomei o atendimento de *${pending.contactLabel}* e já enviei a resposta para o cliente:\n\n> ${finalReply}`;
}
