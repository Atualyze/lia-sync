import { config } from '../config.mjs';
import { isOwnerKey } from '../core/identity.mjs';
import { isToolEnabled } from './index.mjs';
import { toolConsultarPlanilhaGoogle } from './consultar_planilha_google.mjs';

const DEDUPE_WINDOW_MS = 6 * 3600_000;

function formatBrtDateTime(ms = Date.now(), timezone = 'America/Sao_Paulo') {
  try {
    return new Date(ms).toLocaleString('pt-BR', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Registra automaticamente leads qualificados, agendamentos confirmados e transbordos
 * na aba `Leads` da planilha padrão do Google Sheets (`googleSheetsDefaultId`).
 * - Best-effort (nunca bloqueia nem quebra o atendimento ao cliente)
 * - Ignora simulações e chat interno do dono
 * - Deduplica o mesmo (estágio + interesse) na janela de 6 horas por contato
 */
export async function syncLeadToGoogleSheet({
  session,
  stage = 'Qualificado',
  interest = '',
  value = '',
  notes = '',
  botConfig = {},
  now = () => Date.now(),
  executeAppend = null
} = {}) {
  if (!session || typeof session !== 'object') return { synced: false, reason: 'no_session' };
  const phone = String(session.phone || '').trim();
  if (!phone || isOwnerKey(phone) || phone.startsWith('sim:') || session.origin === 'simulation') {
    return { synced: false, reason: 'non_client_session' };
  }
  if (!isToolEnabled('consultar_planilha_google', botConfig)) {
    return { synced: false, reason: 'tool_disabled' };
  }
  const spreadsheetId = String(
    config.googleSheetsDefaultId ||
    process.env.GOOGLE_SHEETS_DEFAULT_ID ||
    botConfig?.integrations?.googleSheets?.defaultSpreadsheetId ||
    ''
  ).trim();
  if (!spreadsheetId) {
    return { synced: false, reason: 'no_spreadsheet_id' };
  }

  const cleanStage = String(stage || 'Qualificado').trim().slice(0, 60);
  const cleanInterest = String(interest || session.sectorName || session.contextSummary || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const cleanValue = String(value || '').trim().slice(0, 60);
  const cleanNotes = String(notes || session.contextSummary || '').replace(/\s+/g, ' ').trim().slice(0, 260);
  const sig = `${cleanStage.toLowerCase()}|${cleanInterest.toLowerCase().slice(0, 60)}`;
  const nowMs = now();
  const prevAt = Date.parse(session.lastSheetSyncAt || '');
  if (session.lastSheetSyncSig === sig && Number.isFinite(prevAt) && (nowMs - prevAt) < DEDUPE_WINDOW_MS) {
    return { synced: false, reason: 'deduped' };
  }

  const tz = botConfig?.businessHours?.timezone || 'America/Sao_Paulo';
  const cleanPhone = phone.replace(/@.*$/, '').replace(/\D/g, '') || phone;
  const clientName = String(session.clientName || session.contactName || session.pushName || 'Lead WhatsApp').trim().slice(0, 100);
  const rowValues = [
    formatBrtDateTime(nowMs, tz),
    clientName,
    cleanPhone,
    cleanInterest || '-',
    cleanStage,
    cleanValue || '-',
    cleanNotes || '-'
  ];

  try {
    const runner = executeAppend || ((args, ctx) => toolConsultarPlanilhaGoogle.execute(args, ctx));
    const res = await runner(
      { acao: 'adicionar_linha', spreadsheetId, range: 'Leads!A:G', valores: rowValues },
      { actor: 'system', botConfig }
    );
    if (res?.success) {
      session.lastSheetSyncSig = sig;
      session.lastSheetSyncAt = new Date(nowMs).toISOString();
      return { synced: true, updatedRange: res.updatedRange || 'Leads!A:G', row: rowValues };
    }
    return { synced: false, reason: res?.error || 'append_failed' };
  } catch (err) {
    return { synced: false, reason: err?.message || 'append_error' };
  }
}
