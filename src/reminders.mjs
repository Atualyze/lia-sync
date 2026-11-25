import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Lembretes do Copiloto.
 *
 * Persistência: arquivo JSON local (fonte de verdade de uma réplica) + espelho
 * opcional no Supabase. Duas garantias que a revisão exigiu:
 *
 *  1. Escrita atômica (`.tmp` + `rename`): uma interrupção no meio do write não
 *     corrompe o arquivo. Antes o `fs.writeFile` direto podia truncar o JSON e o
 *     `load()` seguinte descartava TODOS os lembretes.
 *  2. `load()` nunca zera a lista por erro de parse: o arquivo é preservado, o
 *     erro é registrado e a lista anterior em memória permanece. Só ENOENT
 *     (arquivo inexistente) resulta em lista vazia.
 */
function normalizeReminderPhone(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw.startsWith('sim:')) return '';
  if (/^\d+@lid$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits || raw;
}

export class ReminderStore {
  constructor(filePath = './data/reminders.json', { client = null, logger = console, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.client = client;
    this.logger = logger;
    this.now = now;
    this.reminders = [];
    this.loaded = false;
    this.writing = null;
  }

  async load() {
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.reminders = parsed;
      } else {
        // JSON válido mas de formato inesperado: não destrói o arquivo nem a memória.
        this.logger.error?.('[reminders] arquivo de lembretes não contém uma lista; mantendo estado anterior');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // Primeira execução: lista vazia é o estado correto.
        this.reminders = [];
      } else {
        // Parse inválido, permissão, I/O: preserva o arquivo e a lista anterior.
        this.logger.error?.(`[reminders] não foi possível ler ${path.basename(this.filePath)}; mantendo lembretes anteriores: ${error?.message || error?.code || 'erro desconhecido'}`);
      }
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
              createdAt: row.created_at || new Date(this.now()).toISOString()
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

  /** Serializa as gravações locais na ordem em que foram pedidas. */
  async save() {
    const write = async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(this.reminders, null, 2), 'utf8');
        await fs.rename(tmp, this.filePath);
      } catch (error) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
    };
    this.writing = (this.writing || Promise.resolve()).catch(() => {}).then(write);
    return this.writing;
  }

  async add({ text, dueAt, phone = '', clientName = '', createdBy = 'contato' }) {
    let dueIso = null;
    try {
      const d = new Date(dueAt);
      if (!isNaN(d.getTime())) dueIso = d.toISOString();
    } catch {}

    if (!dueIso) {
      dueIso = new Date(this.now() + 3600000).toISOString();
    }

    const item = {
      id: `rem_${this.now()}_${Math.random().toString(36).slice(2, 7)}`,
      text: String(text).trim(),
      dueAt: dueIso,
      phone,
      clientName,
      createdBy,
      status: 'pending',
      createdAt: new Date(this.now()).toISOString()
    };
    this.reminders.push(item);
    try {
      await this.save();

      if (this.client?.enabled) {
        await this.client.upsert('reminders', [{
          id: item.id,
          text: item.text,
          due_at: item.dueAt,
          phone: item.phone || null,
          client_name: item.clientName || null,
          created_by: item.createdBy,
          status: item.status,
          created_at: item.createdAt
        }], 'id');
      }
    } catch (err) {
      this.reminders = this.reminders.filter(reminder => reminder.id !== item.id);
      await this.save().catch(() => {});
      this.logger.warn?.(`[reminders] Erro ao persistir lembrete: ${err.message}`);
      throw err;
    }

    return item;
  }

  getPendingDue(now = this.now()) {
    return this.reminders.filter(r => r.status === 'pending' && new Date(r.dueAt).getTime() <= now);
  }

  /**
   * Marca o lembrete como enviado e persiste (local e remoto).
   *
   * Retorna uma Promise aguardável que propaga a falha de persistência: quem faz
   * `await` recebe o erro. Chamadores legados que não aguardam (o loop de
   * manutenção ainda chama sem `await`) não geram `unhandledRejection`, porque um
   * handler é anexado à mesma Promise — o erro continua visível para quem aguarda.
   */
  markSent(id) {
    const promise = this._markSent(id);
    promise.catch(() => {});
    return promise;
  }

  async _markSent(id) {
    const item = this.reminders.find(r => r.id === id);
    if (!item) return false;

    item.status = 'sent';
    item.sentAt = new Date(this.now()).toISOString();
    await this.save();

    if (this.client?.enabled) {
      await this.client.request('reminders', {
        method: 'PATCH',
        query: `id=eq.${encodeURIComponent(id)}`,
        body: { status: 'sent', sent_at: item.sentAt }
      });
    }

    return true;
  }

  listActive() {
    return this.reminders.filter(r => r.status === 'pending').sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  }

  /**
   * Consulta somente lembretes vinculados ao identificador autenticado do contato.
   * Números são comparados completos; IDs @lid só correspondem ao mesmo @lid.
   * Não usa sufixos/últimos dígitos, para impedir colisões entre contatos.
   */
  async listActiveForPhone(phone) {
    const phoneKey = normalizeReminderPhone(phone);
    if (!phoneKey) return [];

    // Com Supabase, consulta a fonte remota pelo telefone completo e pagina
    // todos os registros pendentes desse contato. Não usa a amostra global
    // limitada carregada no bootstrap, nem retorna contagem parcial em falhas.
    if (this.client?.enabled) {
      const pageSize = 1000;
      const maxPages = 100;
      const rows = [];
      let offset = 0;
      let pageCount = 0;
      while (true) {
        const query = [
          'select=id,text,due_at,phone,client_name,created_by,status,created_at',
          'phone=eq.' + encodeURIComponent(phoneKey),
          'status=eq.pending',
          'order=created_at.asc,id.asc',
          'limit=' + pageSize,
          'offset=' + offset
        ].join('&');
        const page = await this.client.select('reminders', query);
        if (!Array.isArray(page)) {
          throw new Error('Resposta inválida ao consultar lembretes no Supabase');
        }
        rows.push(...page.filter(row =>
          normalizeReminderPhone(row?.phone) === phoneKey
          && String(row?.status || 'pending') === 'pending'
        ));
        pageCount += 1;
        if (page.length < pageSize) break;
        if (pageCount >= maxPages) {
          throw new Error('A consulta excedeu o limite seguro de páginas; não é possível informar uma contagem completa');
        }
        offset += page.length;
      }
      return rows.map(row => ({
        id: row.id,
        text: row.text,
        dueAt: row.due_at,
        phone: row.phone || '',
        clientName: row.client_name || '',
        createdBy: row.created_by || 'contato',
        status: row.status || 'pending',
        createdAt: row.created_at || new Date(this.now()).toISOString()
      }));
    }

    return this.listActive().filter(item => normalizeReminderPhone(item.phone) === phoneKey);
  }
}
