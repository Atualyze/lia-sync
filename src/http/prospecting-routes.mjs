import { json, readBody, NOT_HANDLED } from './utils.mjs';

function mapProspectingError(err) {
  const msg = String(err?.message || '');
  if (/prospect_lists|prospect_leads|42P01|does not exist|Could not find the table/i.test(msg)) {
    return {
      status: 503,
      body: {
        error: 'prospecting_migration_missing',
        message: 'Tabelas de prospecção não encontradas no Supabase. Execute a migration 20261115_prospecting.sql.'
      }
    };
  }
  return {
    status: 500,
    body: { error: 'prospecting_error', message: msg || 'Erro interno no módulo de prospecção.' }
  };
}

/**
 * Dashboard HTTP routes for prospecting lists, CSV/JSON lead import, and status control.
 */
export async function handleProspectingRoutes({ req, res, u, prospecting }) {
  if (!u.pathname.startsWith('/api/dashboard/prospecting')) return NOT_HANDLED;
  if (!prospecting?.leadStore) return json(res, 503, { error: 'prospecting_unavailable' });

  try {
    if (req.method === 'GET' && u.pathname === '/api/dashboard/prospecting/lists') {
      const lists = await prospecting.leadStore.listListsWithStats();
      return json(res, 200, { ok: true, enabled: prospecting.enabled, lists });
    }

    if (req.method === 'POST' && u.pathname === '/api/dashboard/prospecting/lists') {
      const body = await readBody(req).catch(() => ({}));
      const name = String(body?.name || '').trim();
      if (!name) return json(res, 400, { error: 'invalid_name', message: 'Informe um nome para a lista.' });

      const rawInput = body?.leads ?? body?.leadsText ?? '';
      const { leads, rejected } = prospecting.importLeads(rawInput);
      if (!leads.length) {
        return json(res, 400, {
          error: 'no_valid_leads',
          message: 'Nenhum celular válido encontrado no CSV/JSON.',
          rejectedCount: rejected.length
        });
      }

      const startAt = body?.startAt ? new Date(body.startAt) : null;
      const endAt = body?.endAt ? new Date(body.endAt) : null;
      if ((startAt && Number.isNaN(startAt.getTime())) || (endAt && Number.isNaN(endAt.getTime()))) {
        return json(res, 400, { error: 'invalid_schedule', message: 'Data/hora de início ou término inválida.' });
      }
      if (startAt && endAt && endAt <= startAt) {
        return json(res, 400, { error: 'invalid_schedule', message: 'A data/hora de término deve ser posterior ao início.' });
      }

      const list = await prospecting.leadStore.createList({
        name,
        source: body?.source || 'dashboard',
        segment: String(body?.segment || '').trim(),
        consentBasis: String(body?.consentBasis || '').trim(),
        dailyCap: Math.max(1, Math.min(500, Number(body?.dailyCap) || 20)),
        status: body?.activate ? 'active' : 'paused',
        startAt: startAt ? startAt.toISOString() : null,
        endAt: endAt ? endAt.toISOString() : null
      });
      const inserted = await prospecting.leadStore.addLeads(list.id, leads);

      return json(res, 201, {
        ok: true,
        list,
        importedCount: inserted.length,
        rejectedCount: rejected.length,
        rejectedSample: rejected.slice(0, 10)
      });
    }

    const statusMatch = u.pathname.match(/^\/api\/dashboard\/prospecting\/lists\/([0-9a-f-]{36})\/status$/i);
    if (req.method === 'POST' && statusMatch) {
      const body = await readBody(req).catch(() => ({}));
      const status = String(body?.status || '').trim();
      if (!['active', 'paused', 'stopped'].includes(status)) {
        return json(res, 400, { error: 'invalid_status', message: 'Status deve ser active, paused ou stopped.' });
      }
      const updated = await prospecting.leadStore.setListStatus(statusMatch[1], status);
      if (!updated) return json(res, 404, { error: 'list_not_found' });
      return json(res, 200, { ok: true, list: updated });
    }

    if (req.method === 'POST' && u.pathname === '/api/dashboard/prospecting/tick') {
      const body = await readBody(req).catch(() => ({}));
      const testMode = Boolean(body?.testMode);
      const summary = await prospecting.tick(testMode ? { enabled: true, config: { testMode: true } } : {});
      return json(res, 200, { ok: true, testMode, summary });
    }

    return NOT_HANDLED;
  } catch (err) {
    const mapped = mapProspectingError(err);
    return json(res, mapped.status, mapped.body);
  }
}
