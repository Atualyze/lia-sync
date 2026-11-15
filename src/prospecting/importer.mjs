import { normalizePhone } from '../sessions.mjs';

function isValidBrazilianMobile(phone = '') {
  const digits = normalizePhone(phone);
  return /^55\d{2}9\d{8}$/.test(digits);
}

function parseCsvLine(line = '', delimiter = ',') {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parses CSV or JSON lead arrays, normalizes phones, filters to valid mobile numbers,
 * and deduplicates by normalized phone.
 */
export function importProspectLeads(input) {
  let rows = [];
  if (Array.isArray(input)) {
    rows = input;
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { leads: [], rejected: [] };
    if (trimmed.startsWith('[')) {
      rows = JSON.parse(trimmed);
    } else {
      const lines = trimmed.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return { leads: [], rejected: [] };
      const delimiter = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
      const headers = parseCsvLine(lines[0], delimiter).map(h => h.toLowerCase());
      rows = lines.slice(1).map(line => {
        const vals = parseCsvLine(line, delimiter);
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = vals[idx] ?? ''; });
        return obj;
      });
    }
  }

  const seen = new Set();
  const leads = [];
  const rejected = [];

  for (const row of rows) {
    const rawPhone = row?.phone ?? row?.telefone ?? row?.celular ?? row?.whatsapp ?? '';
    const phone = normalizePhone(rawPhone);
    const name = String(row?.name ?? row?.nome ?? '').trim();

    if (!isValidBrazilianMobile(phone)) {
      rejected.push({ rawPhone, name, reason: 'invalid_mobile' });
      continue;
    }
    if (seen.has(phone)) {
      rejected.push({ rawPhone, phone, name, reason: 'duplicate' });
      continue;
    }
    seen.add(phone);

    const context = typeof row?.context === 'object' && row.context !== null
      ? { ...row.context }
      : {
          segment: String(row?.segment ?? row?.segmento ?? '').trim(),
          notes: String(row?.notes ?? row?.observacoes ?? row?.contexto ?? '').trim()
        };

    leads.push({ phone, name, context });
  }

  return { leads, rejected };
}
