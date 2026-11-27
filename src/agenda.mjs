import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const VALID_STATUSES = new Set(['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show']);

export class AgendaStore {
  constructor(filePath = './data/agenda.json', { client = null, logger = console, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.client = client;
    this.logger = logger;
    this.now = now;
    this.events = [];
    this.loaded = false;
    this.writing = null;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.events = parsed;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.events = [];
      } else {
        this.logger.warn?.(`[agenda] falha ao ler ${path.basename(this.filePath)}: ${error?.message || error}`);
      }
    }

    if (this.client?.enabled) {
      try {
        const rows = await this.client.select(
          'runtime_projections',
          'select=payload,updated_at&projection_key=eq.agenda_events&limit=1'
        );
        const remoteEvents = rows?.[0]?.payload?.events;
        if (Array.isArray(remoteEvents) && remoteEvents.length) {
          const map = new Map();
          for (const ev of this.events) if (ev?.id) map.set(ev.id, ev);
          for (const ev of remoteEvents) {
            if (!ev?.id) continue;
            const local = map.get(ev.id);
            const localTs = Date.parse(local?.updatedAt || local?.createdAt || 0) || 0;
            const remoteTs = Date.parse(ev.updatedAt || ev.createdAt || 0) || 0;
            if (!local || remoteTs >= localTs) map.set(ev.id, ev);
          }
          this.events = Array.from(map.values());
        }
      } catch (err) {
        this.logger.warn?.(`[agenda] Supabase indisponível no load: ${err?.message || err}`);
      }
    }

    this.loaded = true;
    return this.events;
  }

  async save() {
    const writeLocal = async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(this.events, null, 2), 'utf8');
        await fs.rename(tmp, this.filePath);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    };
    this.writing = (this.writing || Promise.resolve()).catch(() => {}).then(writeLocal);
    await this.writing;

    if (this.client?.enabled) {
      try {
        await this.client.upsert(
          'runtime_projections',
          [{
            projection_key: 'agenda_events',
            payload: { events: this.events.slice(-1000) },
            updated_at: new Date(this.now()).toISOString()
          }],
          'projection_key',
          { returnRepresentation: false }
        );
      } catch (err) {
        this.logger.warn?.(`[agenda] falha ao espelhar no Supabase: ${err?.message || err}`);
      }
    }
  }

  list() {
    return [...this.events].sort((a, b) => Date.parse(a.startAt || 0) - Date.parse(b.startAt || 0));
  }

  getById(id) {
    return this.events.find(ev => ev.id === id) || null;
  }

  async add({
    title,
    startAt,
    endAt = null,
    durationMinutes = 30,
    phone = '',
    clientName = '',
    notes = '',
    status = 'scheduled',
    source = 'dashboard',
    googleEventId = null,
    googleHtmlLink = null
  }) {
    const startDate = new Date(startAt);
    if (Number.isNaN(startDate.getTime())) {
      throw new Error('Data/hora de início inválida.');
    }
    const dur = Math.max(5, Math.min(480, Number(durationMinutes) || 30));
    const endDate = endAt && !Number.isNaN(new Date(endAt).getTime())
      ? new Date(endAt)
      : new Date(startDate.getTime() + dur * 60000);
    const nowIso = new Date(this.now()).toISOString();
    const cleanPhone = String(phone || '').replace(/@.*$/, '').replace(/\D/g, '');
    const item = {
      id: `ag_${crypto.randomUUID()}`,
      type: 'meeting',
      title: String(title || '').trim() || (clientName ? `Atendimento · ${clientName}` : 'Agendamento'),
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      durationMinutes: Math.max(5, Math.round((endDate.getTime() - startDate.getTime()) / 60000)),
      phone: cleanPhone,
      clientName: String(clientName || '').trim(),
      notes: String(notes || '').trim(),
      status: VALID_STATUSES.has(status) ? status : 'scheduled',
      source: String(source || 'dashboard'),
      googleEventId: googleEventId || null,
      googleHtmlLink: googleHtmlLink || null,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    this.events.push(item);
    await this.save();
    return item;
  }

  async update(id, patch = {}) {
    const item = this.getById(id);
    if (!item) return null;
    if (patch.title !== undefined) item.title = String(patch.title || '').trim() || item.title;
    if (patch.notes !== undefined) item.notes = String(patch.notes || '').trim();
    if (patch.phone !== undefined) item.phone = String(patch.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
    if (patch.clientName !== undefined) item.clientName = String(patch.clientName || '').trim();
    if (patch.status !== undefined && VALID_STATUSES.has(patch.status)) item.status = patch.status;
    if (patch.googleEventId !== undefined) item.googleEventId = patch.googleEventId || null;
    if (patch.googleHtmlLink !== undefined) item.googleHtmlLink = patch.googleHtmlLink || null;
    if (patch.startAt !== undefined) {
      const startDate = new Date(patch.startAt);
      if (Number.isNaN(startDate.getTime())) throw new Error('Data/hora inválida.');
      const dur = Math.max(5, Math.min(480, Number(patch.durationMinutes ?? item.durationMinutes) || 30));
      item.startAt = startDate.toISOString();
      item.durationMinutes = dur;
      item.endAt = new Date(startDate.getTime() + dur * 60000).toISOString();
    } else if (patch.durationMinutes !== undefined) {
      const dur = Math.max(5, Math.min(480, Number(patch.durationMinutes) || 30));
      const startMs = Date.parse(item.startAt);
      if (Number.isFinite(startMs)) {
        item.durationMinutes = dur;
        item.endAt = new Date(startMs + dur * 60000).toISOString();
      }
    }
    item.updatedAt = new Date(this.now()).toISOString();
    await this.save();
    return item;
  }

  async remove(id) {
    const idx = this.events.findIndex(ev => ev.id === id);
    if (idx === -1) return false;
    this.events.splice(idx, 1);
    await this.save();
    return true;
  }
}
