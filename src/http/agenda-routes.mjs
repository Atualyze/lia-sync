import { json, readBody } from '../http-utils.mjs';
import { toolGerenciarAgenda } from '../tools/gerenciar_agenda_google.mjs';
import { normalizePhone } from '../sessions.mjs';

function formatLocalDatePart(isoOrDate, tz = 'America/Sao_Paulo') {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const timeParts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return { date: dateParts, time: timeParts };
}

export async function handleAgendaRoutes({
  req,
  res,
  u,
  store,
  adminConfig,
  agendaStore = null,
  reminderStore = null,
  liaRuntime = null
}) {
  const pathname = u.pathname;
  const botConfig = adminConfig?.getActiveConfig?.() || {};
  const timezone = botConfig?.integrations?.googleCalendar?.timezone || botConfig?.business?.hoursConfig?.timezone || 'America/Sao_Paulo';

  if (req.method === 'GET' && pathname === '/api/dashboard/agenda') {
    const typeFilter = u.searchParams.get('type') || 'all';
    const includeGoogle = u.searchParams.get('includeGoogle') !== '0';

    const items = [];
    const googleSyncedIds = new Set();

    // 1. Agenda própria (reuniões / horários marcados)
    if (agendaStore) {
      for (const ev of agendaStore.list()) {
        if (ev.googleEventId) googleSyncedIds.add(ev.googleEventId);
        items.push({
          id: ev.id,
          type: 'meeting',
          title: ev.title,
          startAt: ev.startAt,
          endAt: ev.endAt,
          durationMinutes: ev.durationMinutes || 30,
          phone: ev.phone || '',
          clientName: ev.clientName || '',
          notes: ev.notes || '',
          status: ev.status || 'scheduled',
          source: ev.source || 'dashboard',
          googleEventId: ev.googleEventId || null,
          googleHtmlLink: ev.googleHtmlLink || null
        });
      }
    }

    // 2. Lembretes & Retornos WhatsApp (ReminderStore)
    if (reminderStore) {
      const remList = typeof reminderStore.listAll === 'function' ? reminderStore.listAll() : reminderStore.listActive();
      for (const r of remList) {
        items.push({
          id: r.id,
          type: 'reminder',
          title: r.text || 'Retorno / Lembrete',
          startAt: r.dueAt,
          endAt: r.dueAt,
          durationMinutes: 15,
          phone: r.phone || '',
          clientName: r.clientName || '',
          notes: `Criado por: ${r.createdBy || 'contato'}`,
          status: r.status || 'pending',
          source: r.createdBy || 'reminder'
        });
      }
    }

    // 3. Compromissos autônomos do Lia Runtime
    if (liaRuntime?.available && liaRuntime?.commitments?.list) {
      try {
        const commitments = await liaRuntime.commitments.list();
        for (const c of commitments || []) {
          items.push({
            id: c.id,
            type: 'commitment',
            title: c.title || c.description || 'Compromisso da Lia',
            startAt: c.due_at || c.dueAt || c.created_at,
            endAt: c.due_at || c.dueAt || c.created_at,
            durationMinutes: 15,
            phone: '',
            clientName: c.recipient_type === 'owner' ? 'Responsável (Interno)' : 'Lia Runtime',
            notes: c.description || '',
            status: c.status || 'pending',
            source: 'lia_runtime'
          });
        }
      } catch {}
    }

    // 4. Google Calendar (opcional - espelho quando conectado)
    let googleConnected = false;
    if (includeGoogle) {
      try {
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
        const gRes = await toolGerenciarAgenda.execute(
          { action: 'listar_eventos', date: todayStr, days: 14 },
          { actor: 'owner', botConfig }
        );
        if (gRes?.success) {
          googleConnected = true;
          for (const ge of gRes.events || []) {
            if (ge.id && googleSyncedIds.has(ge.id)) continue;
            items.push({
              id: `gcal:${ge.id}`,
              googleEventId: ge.id,
              type: 'google',
              title: ge.title || '(Sem título)',
              startAt: ge.start,
              endAt: ge.end || ge.start,
              durationMinutes: 30,
              phone: '',
              clientName: 'Google Calendar',
              notes: '',
              status: 'confirmed',
              source: 'google_calendar',
              googleHtmlLink: ge.htmlLink || null
            });
          }
        }
      } catch {}
    }

    const filtered = typeFilter === 'all' ? items : items.filter(i => i.type === typeFilter);
    filtered.sort((a, b) => Date.parse(a.startAt || 0) - Date.parse(b.startAt || 0));

    return json(res, 200, {
      ok: true,
      timezone,
      googleConnected,
      items: filtered,
      summary: {
        total: items.length,
        meetings: items.filter(i => i.type === 'meeting' && !['cancelled', 'completed'].includes(i.status)).length,
        reminders: items.filter(i => i.type === 'reminder' && i.status === 'pending').length,
        commitments: items.filter(i => i.type === 'commitment' && ['pending', 'in_progress', 'overdue'].includes(i.status)).length,
        google: items.filter(i => i.type === 'google').length
      }
    });
  }

  if (req.method === 'POST' && pathname === '/api/dashboard/agenda') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }

    const itemType = String(body.type || 'meeting').trim().toLowerCase();
    const title = String(body.title || '').trim();
    const startAt = String(body.startAt || '').trim();
    if (!title) return json(res, 400, { error: 'title_required', message: 'Informe um título ou assunto.' });
    if (!startAt || Number.isNaN(new Date(startAt).getTime())) {
      return json(res, 400, { error: 'invalid_start_at', message: 'Data e hora inválidas.' });
    }

    const rawPhone = String(body.phone || '').trim();
    const cleanPhone = rawPhone ? (normalizePhone(rawPhone) || rawPhone.replace(/\D/g, '')) : '';
    const session = cleanPhone ? store?.get?.(cleanPhone) : null;
    const clientName = String(body.clientName || session?.clientName || session?.contactName || '').trim();
    const durationMinutes = Math.max(5, Math.min(480, Number(body.durationMinutes) || 30));

    if (itemType === 'reminder') {
      if (!reminderStore) return json(res, 503, { error: 'reminders_unavailable' });
      const created = await reminderStore.add({
        text: title,
        dueAt: new Date(startAt).toISOString(),
        phone: cleanPhone,
        clientName,
        createdBy: 'painel'
      });
      if (session && !session.notALead && body.updateFunnel !== false) {
        session.funnelStage = 'agendado';
        session.updatedAt = new Date().toISOString();
        store?.markDirty?.();
      }
      return json(res, 201, { ok: true, type: 'reminder', item: created });
    }

    if (!agendaStore) return json(res, 503, { error: 'agenda_unavailable' });
    let googleEventId = null;
    let googleHtmlLink = null;
    let googleSyncError = null;

    if (body.syncGoogle) {
      try {
        const { date, time } = formatLocalDatePart(startAt, timezone);
        const gRes = await toolGerenciarAgenda.execute({
          action: 'criar_evento',
          date,
          time,
          durationMinutes,
          summary: clientName ? `${title} · ${clientName}` : title,
          description: body.notes || '',
          attendeePhone: cleanPhone || undefined
        }, { actor: 'owner', botConfig });
        if (gRes?.success && gRes.event) {
          googleEventId = gRes.event.id || null;
          googleHtmlLink = gRes.event.htmlLink || null;
        } else {
          googleSyncError = gRes?.message || gRes?.error || 'google_sync_failed';
        }
      } catch (err) {
        googleSyncError = err?.message || 'google_sync_failed';
      }
    }

    const created = await agendaStore.add({
      title,
      startAt,
      durationMinutes,
      phone: cleanPhone,
      clientName,
      notes: body.notes || '',
      status: body.status || 'scheduled',
      source: 'dashboard',
      googleEventId,
      googleHtmlLink
    });

    if (session && !session.notALead && body.updateFunnel !== false) {
      session.funnelStage = 'agendado';
      session.scheduled = true;
      session.updatedAt = new Date().toISOString();
      store?.markDirty?.();
    }

    return json(res, 201, { ok: true, type: 'meeting', item: created, googleSyncError });
  }

  const itemMatch = pathname.match(/^\/api\/dashboard\/agenda\/([^/]+)$/);
  if (itemMatch) {
    const id = decodeURIComponent(itemMatch[1]);
    if (req.method === 'PATCH' || req.method === 'PUT') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
      const itemType = String(body.type || (id.startsWith('rem_') ? 'reminder' : 'meeting')).toLowerCase();

      if (itemType === 'reminder') {
        if (!reminderStore?.updateStatus) return json(res, 503, { error: 'reminders_unavailable' });
        const updated = await reminderStore.updateStatus(id, String(body.status || 'completed'));
        if (!updated) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { ok: true, item: updated });
      }

      if (itemType === 'commitment') {
        if (!liaRuntime?.available) return json(res, 503, { error: 'runtime_unavailable' });
        const act = body.status === 'cancelled' ? 'cancel' : 'fulfill';
        const updated = act === 'cancel'
          ? await liaRuntime.commitments.cancel(id)
          : await liaRuntime.commitments.fulfill(id);
        return json(res, 200, { ok: true, item: updated });
      }

      if (!agendaStore) return json(res, 503, { error: 'agenda_unavailable' });
      const existing = agendaStore.getById(id);
      if (!existing) return json(res, 404, { error: 'not_found' });
      if (body.status === 'cancelled' && existing.googleEventId) {
        await toolGerenciarAgenda.execute(
          { action: 'cancelar_evento', eventId: existing.googleEventId },
          { actor: 'owner', botConfig }
        ).catch(() => {});
      }
      const updated = await agendaStore.update(id, body);
      return json(res, 200, { ok: true, item: updated });
    }

    if (req.method === 'DELETE') {
      if (id.startsWith('rem_')) {
        const updated = await reminderStore?.updateStatus?.(id, 'cancelled');
        if (!updated) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { ok: true, id });
      }
      if (id.startsWith('gcal:')) {
        const eventId = id.slice(5);
        const gRes = await toolGerenciarAgenda.execute({ action: 'cancelar_evento', eventId }, { actor: 'owner', botConfig });
        return json(res, gRes?.success ? 200 : 400, { ok: Boolean(gRes?.success), error: gRes?.error || null });
      }
      const existing = agendaStore?.getById?.(id);
      if (!existing) return json(res, 404, { error: 'not_found' });
      if (existing.googleEventId) {
        await toolGerenciarAgenda.execute({ action: 'cancelar_evento', eventId: existing.googleEventId }, { actor: 'owner', botConfig }).catch(() => {});
      }
      await agendaStore.remove(id);
      return json(res, 200, { ok: true, id });
    }
  }

  return false;
}
