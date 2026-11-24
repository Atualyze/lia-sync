import { normalize } from '../safety.mjs';
import { OWNER_SELF_KEY } from '../core/identity.mjs';

export const ADMIN_CONSULT_TTL_MS = 2 * 60 * 60 * 1000;

const UNEXECUTED_PROMISE_RE = /\b(?:vou\s+(?:buscar|procurar|pegar|checar|consultar|verificar|enviar|mandar|anexar|retornar|avisar|confirmar|resolver)|estou\s+(?:buscando|procurando|checando|consultando|verificando|enviando|anexando)|te\s+retorno|te\s+aviso|já\s+retorno|assim\s+que\s+(?:eu\s+)?(?:souber|confirmar|verificar)|em\s+instantes|já\s+(?:te\s+)?(?:envio|mando|aviso|retorno))\b(?:.{0,100}\b(?:drive|google\s*drive|planilha|sheets|arquivo|contrato|pdf|documento|cat[aá]logo|agenda|equipe|responsável|resposta|informação|confirmação)\b)?/i;

const FAKE_ATTACHMENT_RE = /\b(?:aqui\s+est[aá]|segue(?:\s+em\s+anexo)?|enviei|mandei|anexei|acabei\s+de\s+enviar)\b.{0,60}\b(?:modelo\s+de\s+contrato|contrato|arquivo|pdf|documento|cat[aá]logo|planilha)\b|\barquivo\s+n[aã]o\s+foi\s+anexado\b/i;

const EXPLICIT_UNRELATED_COPILOT_RE = /^(?:status|fila|bot\s+(?:on|off)|humano|expediente|lembretes?|ping|ajuda|help|limpar|reset|pix\b|gerar\s+pix|consultar\s+(?:saude|infra|cep|cnpj|agenda|contato|crm)|mande\s+(?:uma\s+)?mensagem\s+para|envie\s+(?:uma\s+)?mensagem\s+para)\b/i;

/**
 * Detecta promessas vazias de busca/envio no Drive/Planilha/Agenda ou falsa
 * alegação de envio de arquivo/contrato quando nenhuma ferramenta real executou.
 */
export function detectUnexecutedClientPromiseOrFakeAttachment(reply = '') {
  const text = String(reply || '').trim();
  if (!text) return false;
  return UNEXECUTED_PROMISE_RE.test(text) || FAKE_ATTACHMENT_RE.test(text);
}

export function buildAdminConsultNotice({
  clientName = 'Cliente',
  phone = '',
  question = '',
  reason = '',
  assistant = 'Lia'
} = {}) {
  const cleanPhone = String(phone || '').replace(/@.*$/, '');
  return [
    `💬 *Consulta da ${assistant} — Atendimento em andamento*`,
    '',
    `• *Cliente:* ${clientName}${cleanPhone ? ` (${cleanPhone})` : ''}`,
    `• *Pedido do cliente:* "${String(question || '').trim().slice(0, 320)}"`,
    reason ? `• *Motivo:* ${reason}` : '',
    '',
    `_Responda aqui com a orientação ou confirmação. A consulta fica registrada para acompanhamento interno até ser resolvida ou cancelada._`,
    `_(Se preferir assumir o atendimento direto, responda *assumir*; para ignorar, responda *cancelar*.)_`
  ].filter(Boolean).join('\n');
}

export function listPendingAdminConsults(sessions = {}, { nowMs = Date.now() } = {}) {
  const items = [];
  for (const [key, session] of Object.entries(sessions || {})) {
    if (!session || key.startsWith('sim:') || session.origin === 'simulation') continue;
    if (!session.phone || session.phone === OWNER_SELF_KEY || session.archivedAt) continue;
    const consult = session.pendingAdminConsult;
    if (!consult || consult.status !== 'pending') continue;
    const requestedMs = Date.parse(consult.requestedAt || '');
    const ageMs = Number.isFinite(requestedMs) ? Math.max(0, nowMs - requestedMs) : 0;
    // TTL agora indica atraso, não descarte. A consulta continua visível ao
    // responsável até ser respondida ou cancelada explicitamente.
    items.push({
      key,
      session,
      consult,
      requestedMs: Number.isFinite(requestedMs) ? requestedMs : 0,
      ageMs,
      overdue: Number.isFinite(requestedMs) && ageMs > ADMIN_CONSULT_TTL_MS
    });
  }
  return items.sort((a, b) => b.requestedMs - a.requestedMs);
}

export function parseAdminConsultAction(text = '') {
  const raw = String(text || '').trim();
  const norm = normalize(raw);
  if (!norm || EXPLICIT_UNRELATED_COPILOT_RE.test(norm)) return null;
  if (/^(?:assumir|eu\s+assumo|eu\s+respondo|pode\s+deixar\s+comigo|deixa\s+comigo|vou\s+assumir)(?:\s+o\s+atendimento)?[.!\s]*$/i.test(norm)) {
    return { action: 'takeover', text: raw };
  }
  if (/^(?:cancelar|ignorar|descarta|descartar|esquece|deixa\s+pra\s+la)[.!\s]*$/i.test(norm)) {
    return { action: 'cancel', text: raw };
  }
  if (raw.length >= 2) {
    return { action: 'reply', text: raw };
  }
  return null;
}
