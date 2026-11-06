import fs from 'node:fs/promises';
import path from 'node:path';

export class ReminderStore {
  constructor(filePath = './data/reminders.json', { client = null, logger = console } = {}) {
    this.filePath = filePath;
    this.client = client;
    this.logger = logger;
    this.reminders = [];
    this.loaded = false;
  }

  async load() {
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      this.reminders = JSON.parse(data);
      if (!Array.isArray(this.reminders)) this.reminders = [];
    } catch {
      this.reminders = [];
    }

    if (this.client?.enabled) {
      try {
        const rows = await this.client.select('reminders', 'select=*&status=eq.pending&order=due_at.asc&limit=200');
        if (Array.isArray(rows)) {
          const map = new Map();
          for (const r of this.reminders) map.set(r.id, r);
          for (const row of rows) {
            map.set(row.id, {
              id: row.id,
              text: row.text,
              dueAt: row.due_at,
              phone: row.phone || '',
              clientName: row.client_name || '',
              createdBy: row.created_by || 'contato',
              status: row.status || 'pending',
              createdAt: row.created_at || new Date().toISOString()
            });
          }
          this.reminders = Array.from(map.values());
        }
      } catch (err) {
        this.logger.warn?.(`[reminders] Supabase indisponível no load: ${err.message}`);
      }
    }

    this.loaded = true;
    return this.reminders;
  }

  async save() {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.reminders, null, 2), 'utf8');
    } catch (e) {
      console.error('[reminders] Erro ao salvar:', e.message);
    }
  }

  add({ text, dueAt, phone = '', clientName = '', createdBy = 'contato' }) {
    let dueIso = null;
    try {
      const d = new Date(dueAt);
      if (!isNaN(d.getTime())) dueIso = d.toISOString();
    } catch {}

    if (!dueIso) {
      dueIso = new Date(Date.now() + 3600000).toISOString();
    }

    const item = {
      id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      text: String(text).trim(),
      dueAt: dueIso,
      phone,
      clientName,
      createdBy,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    this.reminders.push(item);
    this.save().catch(() => {});

    if (this.client?.enabled) {
      this.client.upsert('reminders', [{
        id: item.id,
        text: item.text,
        due_at: item.dueAt,
        phone: item.phone || null,
        client_name: item.clientName || null,
        created_by: item.createdBy,
        status: item.status,
        created_at: item.createdAt
      }], 'id').catch(err => this.logger.warn?.(`[reminders] Erro ao persistir no Supabase: ${err.message}`));
    }

    return item;
  }

  getPendingDue(now = Date.now()) {
    return this.reminders.filter(r => r.status === 'pending' && new Date(r.dueAt).getTime() <= now);
  }

  markSent(id) {
    const item = this.reminders.find(r => r.id === id);
    if (item) {
      item.status = 'sent';
      item.sentAt = new Date().toISOString();
      this.save().catch(() => {});

      if (this.client?.enabled) {
        this.client.request('reminders', {
          method: 'PATCH',
          query: `id=eq.${encodeURIComponent(id)}`,
          body: { status: 'sent', sent_at: item.sentAt }
        }).catch(err => this.logger.warn?.(`[reminders] Erro ao atualizar status no Supabase: ${err.message}`));
      }
    }
  }

  listActive() {
    return this.reminders.filter(r => r.status === 'pending').sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  }
}
