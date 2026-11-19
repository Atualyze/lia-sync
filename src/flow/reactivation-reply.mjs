import { buildSystemPrompt } from '../knowledge.mjs';
import { filterReply } from '../safety.mjs';
import { formatOutgoingMessage } from '../core/format.mjs';
import { resolveIdentity } from '../core/identity.mjs';
import { getAllowedPrices } from '../faq.mjs';

const PENDING_TTL_MS = 30 * 60 * 1000;
const LOW_CONFIDENCE = 0.6;

const INTENTS = {
  HUMAN: 'Combinado! Mantive *${label}* no **modo humano** aguardando você.',
  CLOSE: 'Perfeito! Concluí e encerrei o atendimento de *${label}*.'
};

const CONFIRM_YES_RE = /^(?:sim|confirmo|confirmado|isso|isso mesmo|correto|correta|exato|exata|ok|okay|beleza|blz|pode|pode sim|certo|certa|perfeito|aprovo|aprovar)\b/i;
const CONFIRM_NO_RE = /^(?:n[aã]o|n|negativo|errado|errada|cancela|cancelar|esquece|esquecer|outro|outra|nao foi isso|não foi isso)\b/i;

function extractJson(text) {
  const raw = String(text || '');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function normalizeIntent(value) {
  const v = String(value || '').trim().toUpperCase();
  return ['HUMAN', 'CLOSE', 'BOT_CONTINUE', 'UNCERTAIN'].includes(v) ? v : null;
}

/**
 * Classifica a mensagem do admin em linguagem natural via IA, retornando
 * { intent, confidence, interpretation } ou null quando a IA não responde
 * de forma utilizável (o chamador então usa o fallback por regex).
 */
async function classifyReactivationIntent({ ai, botConfig, cmd, pending, sTarget, now }) {
  if (!ai || typeof ai.askAI !== 'function') return null;

  const identity = resolveIdentity(botConfig || {});
  const assistantName = identity.botName || 'assistente';
  const recentMessages = Array.isArray(sTarget?.history)
    ? sTarget.history.slice(-8).map(m => `${m.role === 'user' ? 'Admin/Cliente' : assistantName}: ${String(m.content || '').slice(0, 200)}`).join('\n')
    : '';

  const context = [
    `Contato: ${pending.contactLabel || '(sem nome)'} (${pending.phone})`,
    `Há mensagem do cliente sem resposta: ${pending.unanswered ? 'sim' : 'não'}`,
    pending.snippet ? `Última mensagem pendente do cliente: "${String(pending.snippet).slice(0, 300)}"` : '',
    recentMessages ? `Últimas mensagens da sessão:\n${recentMessages}` : '',
    `Mensagem do dono/admin agora: "${cmd}"`
  ].filter(Boolean).join('\n');

  const system = [
    'Você classifica a intenção de um dono/admin ao responder uma notificação interna sobre retomar o atendimento de um cliente por um bot de WhatsApp.',
    'Responda APENAS com um JSON pequeno, sem texto ao redor, no formato exato:',
    '{"intent":"HUMAN|CLOSE|BOT_CONTINUE|UNCERTAIN","confidence":<0 a 1>,"interpretation":"<leitura da frase em uma frase>"}',
    'Significados:',
    '- HUMAN: o admin vai responder o cliente pessoalmente e quer manter o contato no modo humano (ex.: "deixa comigo", "eu respondo", "vou resolver aqui").',
    '- CLOSE: o atendimento já foi concluído pelo admin e o contato pode ser encerrado (ex.: "já resolvi", "pode encerrar", "tudo certo").',
    '- BOT_CONTINUE: o admin autoriza o bot a retomar o atendimento e responder o cliente (ex.: "pode continuar", "segue com ela", "responde o cliente").',
    '- UNCERTAIN: a mensagem é ambígua, fora de contexto ou não dá para decidir entre as opções acima.',
    'Seja conservador: qualquer dúvida real entre opções é UNCERTAIN.'
  ].join('\n');

  let result = null;
  try {
    result = await ai.askAI({
      system,
      history: [],
      userText: context,
      botConfig,
      isOwner: true,
      deadline: (now ? now() : Date.now()) + 15000
    });
  } catch {
    return null;
  }

  const parsed = extractJson(result?.text || result?.reply || '');
  if (!parsed) return null;

  const intent = normalizeIntent(parsed.intent);
  if (!intent) return null;

  const confidence = Number(parsed.confidence);
  return {
    intent,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.5,
    interpretation: String(parsed.interpretation || '').trim()
  };
}

/** Classificação secundária por regex, mantida como fallback quando a IA falha. */
function classifyByRegex(cmd) {
  const wantsHuman = /\b(eu\s+resolv|eu\s+mesm|deixa\s+comigo|mant[eé]m\s+no\s+humano|fica\s+no\s+humano|modo\s+humano|eu\s+atendo|vou\s+responder|assum[eo])\b/i.test(cmd);
  const wantsClose = /\b(j[aá]\s+resolv|pode\s+encerrar|encerr[ae]|conclu[ií]|finaliz[ae]|j[aá]\s+atendi|tudo\s+resolvido)\b/i.test(cmd);
  const wantsBotContinue = /\b(pode\s+(?:continuar|responder|seguir|assumir|dar\s+continuidade)|segue\s+(?:a[ií]|com)|responde\s+(?:ele|ela|o\s+cliente)|vai\s+l[aá]|sim\b|pode\s+sim)\b/i.test(cmd);
  if (wantsHuman) return 'HUMAN';
  if (wantsClose) return 'CLOSE';
  if (wantsBotContinue) return 'BOT_CONTINUE';
  return null;
}

function buildConfirmationQuestion(classification, pending) {
  const label = pending.contactLabel || pending.phone;
  const interpretation = classification?.interpretation;
  if (classification?.intent && classification.intent !== 'UNCERTAIN') {
    const action = classification.intent === 'HUMAN'
      ? 'manter o contato no **modo humano**'
      : classification.intent === 'CLOSE'
        ? '**encerrar** o atendimento'
        : 'retomar o atendimento com resposta da **Lia** ao cliente';
    return interpretation
      ? `Entendi que você quer ${action} sobre *${label}* ("${interpretation}"). Confirma? Responda *sim* ou *não* — ou explique livremente o que deseja.`
      : `Entendi que você quer ${action} sobre *${label}*. Confirma? Responda *sim* ou *não* — ou explique livremente o que deseja.`;
  }
  return interpretation
    ? `Não entendi totalmente ("${interpretation}") sobre *${label}*. Você quer manter no humano, encerrar o atendimento ou retomar com a Lia?`
    : `Não entendi totalmente sua mensagem sobre *${label}*. Você quer manter no humano, encerrar o atendimento ou retomar com a Lia?`;
}

/**
 * Trata a resposta do admin no chat interno quando há uma reativação pendente,
 * interpretando a mensagem em linguagem natural via IA (com fallback por regex)
 * e decidindo entre manter modo humano, concluir o atendimento ou retomar com
 * o cliente enviando uma resposta contextualizada. Intenções incertas pedem
 * confirmação no chat interno, preservando o pending.
 */
export async function handlePendingReactivationReply({
  store, ai, whatsapp, botConfig, sSelf, cleanCommand, findSessionByTarget, now, owner, stageOutboundDispatch
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

  const sTarget = store.get?.(pending.phone) || findSessionByTarget?.(pending.phone);

  // Estado de confirmação aberto por uma resposta anterior incerta.
  if (pending.awaitingConfirmation) {
    const confirmedYes = CONFIRM_YES_RE.test(cmd);
    const confirmedNo = CONFIRM_NO_RE.test(cmd);
    const storedIntent = pending.awaitingConfirmation.intent;

    if (confirmedYes && storedIntent) {
      pending.awaitingConfirmation = null;
      store.markDirty?.();
      if (!sTarget) {
        sSelf.pendingReactivation = null;
        store.markDirty?.();
        return `Não localizei mais a sessão de *${pending.contactLabel || pending.phone}* para aplicar a ação.`;
      }
      sSelf.pendingReactivation = null;
      store.markDirty?.();
      return await applyIntent(storedIntent, { store, sTarget, pending, sSelf, owner, now, ai, whatsapp, botConfig, stageOutboundDispatch });
    }

    if (confirmedNo) {
      pending.awaitingConfirmation = null;
      sSelf.pendingReactivation = null;
      store.markDirty?.();
      return `Tudo bem. Não executei a ação sobre *${pending.contactLabel || pending.phone}* e encerrei essa confirmação.`;
    }

    // Nova instrução: sai do estado de confirmação e reclassifica abaixo.
    pending.awaitingConfirmation = null;
    store.markDirty?.();
  }

  let intent = null;
  // Respostas binárias à pergunta padrão não precisam de nova chamada à IA.
  // "sim" autoriza a Lia a continuar; "não" mantém o atendimento humano.
  let classification = null;
  if (CONFIRM_YES_RE.test(cmd)) intent = 'BOT_CONTINUE';
  else if (CONFIRM_NO_RE.test(cmd)) intent = 'HUMAN';
  else classification = await classifyReactivationIntent({ ai, botConfig, cmd, pending, sTarget, now });

  if (classification) {
    intent = classification.intent;
  } else {
    // Fallback: IA indisponível ou resposta não interpretável.
    intent = classifyByRegex(cmd);
  }

  // Incerto (UNCERTAIN ou confiança baixa): não executa nada, não limpa o pending;
  // responde confirmando a leitura e abre estado de confirmação para o próximo reply.
  if (!intent || intent === 'UNCERTAIN' || (classification && classification.confidence < LOW_CONFIDENCE)) {
    pending.awaitingConfirmation = {
      intent: intent && intent !== 'UNCERTAIN' ? intent : null,
      interpretation: classification?.interpretation || cmd.slice(0, 200),
      createdAt: new Date(now()).toISOString()
    };
    store.markDirty?.();
    return buildConfirmationQuestion(classification, pending);
  }

  if (!sTarget) {
    sSelf.pendingReactivation = null;
    store.markDirty?.();
    return `Não localizei mais a sessão de *${pending.contactLabel || pending.phone}* para aplicar a ação.`;
  }

  sSelf.pendingReactivation = null;
  store.markDirty?.();
  return await applyIntent(intent, { store, sTarget, pending, sSelf, owner, now, ai, whatsapp, botConfig, stageOutboundDispatch });
}

async function applyIntent(intent, { store, sTarget, pending, sSelf, owner, now, ai, whatsapp, botConfig, stageOutboundDispatch }) {
  const nowIso = new Date(now()).toISOString();

  if (intent === 'HUMAN') {
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

  if (intent === 'CLOSE') {
    sTarget.human = false;
    sTarget.humanSource = null;
    sTarget.handoffAt = null;
    sTarget.inactivityClosed = true;
    sTarget.updatedAt = nowIso;
    store.markDirty?.();
    await store.flush?.();
    return `Perfeito! Concluí e encerrei o atendimento de *${pending.contactLabel}*.`;
  }

  // BOT_CONTINUE: Lia retoma e envia resposta natural ao cliente
  const targetJid = sTarget.jid || `${String(pending.phone).replace(/\D/g, '')}@s.whatsapp.net`;
  const sys = buildSystemPrompt({
    session: sTarget,
    now: new Date(now()),
    botConfig,
    isOwner: false
  });
  const lastCustomerMessage = pending.snippet || [...(sTarget.history || [])].reverse()
    .find(message => message?.role === 'user')?.content || '';
  const continuationPrompt = pending.unanswered
    ? `Retome esta conversa como se você tivesse acompanhado todo o atendimento. A última mensagem do cliente ficou sem resposta: "${lastCustomerMessage}". Responda diretamente ao assunto dessa mensagem, aproveitando os dados reais do histórico. Seja natural, humana e acolhedora; não mencione handoff, reativação, modo interno ou que você é um fallback. Não use uma saudação genérica nem pergunte apenas se ficou alguma dúvida.`
    : `Retome esta conversa com base no último assunto real do histórico. A mensagem anterior do cliente já recebeu resposta, então escreva uma continuação curta e humana que faça sentido para aquele contexto. Não mencione handoff, reativação ou modo interno, não use frase pronta genérica e não repita a resposta anterior.`;

  const aiResult = await ai?.askAI?.({
    system: sys,
    history: Array.isArray(sTarget.history) ? sTarget.history.slice(-16) : [],
    userText: continuationPrompt,
    botConfig,
    isOwner: false
  }).catch(() => null);

  const clientName = String(sTarget.clientName || sTarget.contactName || '').trim();
  const fallbackReply = pending.unanswered && lastCustomerMessage
    ? `Oi${clientName ? `, ${clientName}` : ''}! Vi sua mensagem sobre "${lastCustomerMessage}" e quero te ajudar com isso. Pode me confirmar um pouco mais do que você precisa para eu dar sequência?`
    : `Oi${clientName ? `, ${clientName}` : ''}! Retomando nosso atendimento sobre o que conversamos: como você gostaria de seguir?`;
  const rawReply = aiResult?.text || aiResult?.reply || fallbackReply;
  const filteredReply = filterReply(rawReply, { allowedPrices: getAllowedPrices(), strictPrices: true });
  // Nunca entregar texto cru quando o filtro bloqueia: usa mensagem neutra de segurança.
  const finalReply = formatOutgoingMessage(filteredReply.blocked || !filteredReply.text ? fallbackReply : filteredReply.text);

  if (typeof stageOutboundDispatch !== 'function') {
    return 'Não enviei a resposta: este fluxo precisa registrar uma prévia no Copilot para sua confirmação.';
  }
  const preview = await stageOutboundDispatch({
    phone: sTarget.phone || pending.phone,
    recipient: pending.contactLabel || pending.phone,
    message: finalReply,
    asAudio: false
  }, { source: 'reactivation', resumeBot: true });
  return preview || 'Não consegui preparar a continuação para envio agora. O contato continua protegido e nenhuma mensagem foi enviada; tente confirmar novamente em alguns instantes.';
}
