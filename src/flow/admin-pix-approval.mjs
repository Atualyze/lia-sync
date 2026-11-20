import { normalize } from '../safety.mjs';

export const ADMIN_PIX_APPROVAL_TTL_MS = 30 * 60 * 1000;

function cleanDecisionText(value = '') {
  return normalize(String(value || ''))
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Only explicit, named choices may authorize or take over a customer Pix request.
 * Bare "sim", "ok", "pode" and amounts are deliberately not approvals.
 */
export function parseAdminPixDecision(value = '') {
  const text = cleanDecisionText(value);
  if (!text) return null;

  const generate = text.match(
    /^(?:(?:autorizo|confirmo)\s+)?(?:pode\s+)?(?:gerar|gera|gere)\s+(?:e\s+enviar\s+)?(?:o\s+)?pix(?:\s+(?:para|pro|pra)\s+(.+))?$/
  );
  if (generate) {
    return { action: 'generate', target: String(generate[1] || '').trim() || null };
  }

  const assume = text.match(
    /^(?:(?:eu\s+)?(?:vou\s+)?assum(?:ir|o)|assumir|assuma)\s+(?:o\s+)?atendimento(?:\s+(?:de|do|da|para)\s+(.+))?$/
  ) || text.match(
    /^(?:deixa\s+comigo|eu\s+assumo)(?:\s+(?:o\s+)?atendimento)?(?:\s+(?:de|do|da|para)\s+(.+))?$/
  );
  if (assume) {
    return { action: 'assume', target: String(assume[1] || '').trim() || null };
  }

  return null;
}

export function listPendingAdminPixDecisions(sessions = {}, {
  nowMs = Date.now(),
  ttlMs = ADMIN_PIX_APPROVAL_TTL_MS
} = {}) {
  return Object.entries(sessions || {})
    .filter(([, session]) => {
      const decision = session?.pendingAdminDecision;
      if (!decision || decision.type !== 'pix_generation' || decision.status !== 'pending') return false;
      const requestedAt = Date.parse(decision.requestedAt || '');
      return Number.isFinite(requestedAt)
        && requestedAt <= nowMs + 60_000
        && nowMs - requestedAt <= ttlMs
        && Number.isFinite(Number(decision.amount))
        && Number(decision.amount) > 0;
    })
    .map(([key, session]) => ({ key, session, decision: session.pendingAdminDecision }));
}

function phoneDigits(session = {}) {
  return String(session.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
}

function contactLabel(session = {}) {
  return String(session.clientName || session.contactName || session.pushName || '').trim();
}

export function matchPendingAdminPixDecision(candidates = [], target = '') {
  const items = Array.isArray(candidates) ? candidates : [];
  if (!target) return items.length === 1 ? items[0] : null;
  const query = cleanDecisionText(target);
  const digits = query.replace(/\D/g, '');

  const matches = items.filter(item => {
    const phone = phoneDigits(item.session);
    if (digits.length >= 4 && phone && (phone.endsWith(digits) || digits.endsWith(phone))) return true;
    const name = normalize(contactLabel(item.session));
    return name && (name.includes(query) || query.includes(name));
  });
  return matches.length === 1 ? matches[0] : null;
}

export function describePendingAdminPixDecision(item = {}) {
  const session = item.session || {};
  const decision = item.decision || session.pendingAdminDecision || {};
  const name = contactLabel(session) || 'Contato';
  const phone = phoneDigits(session);
  const suffix = phone ? phone.slice(-4) : 'sem número';
  return {
    name,
    suffix,
    label: `${name} (final ${suffix})`,
    amount: Number(decision.amount) || 0,
    requestedAt: decision.requestedAt || null
  };
}

export function buildAdminPixDecisionNotice({ clientName = 'Cliente', phone = '', amount = 0 } = {}) {
  const digits = String(phone || '').replace(/@.*$/, '').replace(/\D/g, '');
  const suffix = digits ? digits.slice(-4) : 'não informado';
  const numericAmount = Number(amount);
  const amountLabel = Number.isFinite(numericAmount)
    ? `R$ ${numericAmount.toFixed(2).replace('.', ',')}`
    : 'valor não informado';

  return [
    '*DECISÃO NECESSÁRIA — COBRANÇA PIX*',
    `Cliente: ${clientName}`,
    `WhatsApp final: ${suffix}`,
    `Valor informado: ${amountLabel}`,
    'Pedido: Pix copia e cola.',
    '',
    'Responda *GERAR PIX* para autorizar a Lia a gerar e enviar a cobrança.',
    'Responda *ASSUMIR ATENDIMENTO* para assumir o contato pessoalmente.',
    'A cobrança não será gerada até uma dessas decisões explícitas.'
  ].join('\n');
}
