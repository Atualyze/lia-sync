import { resolveGoogleAccessToken } from './google_auth.mjs';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function normalizeRows(values = []) {
  if (!Array.isArray(values) || values.length === 0) return { headers: [], rows: [] };
  const [headerRow, ...dataRows] = values;
  const headers = (headerRow || []).map((cell, i) => String(cell || `col_${i + 1}`).trim());
  const rows = dataRows.map((row) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row?.[idx] ?? '';
    });
    return obj;
  });
  return { headers, rows };
}

export const toolConsultarPlanilhaGoogle = {
  name: 'consultar_planilha_google',
  description:
    'Consulta tabelas de preços, estoque, catálogos ou registra novos leads/pedidos no Google Sheets. Use ler_intervalo ou buscar_linhas para consultar e adicionar_linha para gravar.',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: {
        type: 'STRING',
        enum: ['ler_intervalo', 'buscar_linhas', 'adicionar_linha'],
        description: 'Ação desejada na planilha.'
      },
      spreadsheetId: {
        type: 'STRING',
        description: 'ID da planilha do Google Sheets (opcional se GOOGLE_SHEETS_DEFAULT_ID estiver configurado).'
      },
      range: {
        type: 'STRING',
        description: 'Intervalo A1 (ex: "Tabela!A1:E100" ou "A1:E50"). Padrão: "A1:Z100".'
      },
      busca: {
        type: 'STRING',
        description: 'Texto de busca para filtrar linhas na ação buscar_linhas.'
      },
      valores: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: 'Lista de valores na ordem das colunas para adicionar_linha.'
      }
    },
    required: ['acao']
  },

  async execute(args = {}, context = {}) {
    const acao = String(args.acao || '').trim();
    const toolSettings = context?.botConfig?.tools?.settings?.consultar_planilha_google || {};
    const spreadsheetId = String(
      args.spreadsheetId ||
      toolSettings.defaultSpreadsheetId ||
      context?.botConfig?.integrations?.googleSheets?.defaultSpreadsheetId ||
      process.env.GOOGLE_SHEETS_DEFAULT_ID ||
      ''
    ).trim();

    if (!spreadsheetId) {
      return {
        success: false,
        error: 'google_sheets_id_missing',
        message: 'Informe o spreadsheetId ou configure GOOGLE_SHEETS_DEFAULT_ID.'
      };
    }

    if (acao === 'adicionar_linha' && context?.actor === 'client') {
      return {
        success: false,
        error: 'forbidden_in_client_flow',
        message: 'Gravação em planilha é permitida apenas para o operador/proprietário.'
      };
    }

    const token = await resolveGoogleAccessToken({ scopes: SHEETS_SCOPES, envPrefix: 'GOOGLE_SHEETS' });
    if (!token) {
      return {
        success: false,
        error: 'google_sheets_unavailable',
        message: 'Integração com Google Sheets não está configurada (OAuth ou Service Account ausente).'
      };
    }

    const range = String(args.range || toolSettings.defaultRange || 'A1:Z100').trim();
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    };

    if (acao === 'adicionar_linha') {
      const valores = Array.isArray(args.valores) ? args.valores : [];
      if (!valores.length) {
        return { success: false, error: 'missing_values', message: 'Informe "valores" (array) para adicionar na planilha.' };
      }
      const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(12_000),
        body: JSON.stringify({ values: [valores] })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { success: false, error: 'google_sheets_api_error', status: res.status, message: data?.error?.message || 'Falha ao adicionar linha no Google Sheets.' };
      }
      return {
        success: true,
        acao,
        spreadsheetId,
        updatedRange: data?.updates?.updatedRange || range,
        updatedRows: Number(data?.updates?.updatedRows || 1)
      };
    }

    const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: 'google_sheets_api_error', status: res.status, message: data?.error?.message || 'Falha ao ler Google Sheets.' };
    }

    const parsed = normalizeRows(data.values || []);
    if (acao === 'buscar_linhas') {
      const query = String(args.busca || '').trim().toLowerCase();
      const matched = query
        ? parsed.rows.filter((row) => Object.values(row).some((v) => String(v || '').toLowerCase().includes(query)))
        : parsed.rows;
      return {
        success: true,
        acao,
        spreadsheetId,
        range: data.range || range,
        headers: parsed.headers,
        totalMatched: matched.length,
        rows: matched.slice(0, 30)
      };
    }

    return {
      success: true,
      acao,
      spreadsheetId,
      range: data.range || range,
      headers: parsed.headers,
      totalRows: parsed.rows.length,
      rows: parsed.rows.slice(0, 50)
    };
  }
};
