import { StorageAdapter } from './adapter.mjs';

/**
 * Adaptador de armazenamento externo via Supabase REST API.
 * Permite persistir coleções e estados de forma desacoplada do filesystem local,
 * viabilizando múltiplas réplicas do Lia Sync sem divergência de dados.
 */
export class SupabaseStorageAdapter extends StorageAdapter {
  constructor(client, { logger = console, fallbackAdapter = null } = {}) {
    super('supabase');
    this.client = client;
    this.logger = logger;
    this.fallback = fallbackAdapter;
  }

  get enabled() {
    return Boolean(this.client?.enabled);
  }

  async get(collection, key) {
    if (!this.enabled) {
      if (this.fallback) return this.fallback.get(collection, key);
      return null;
    }

    try {
      // Mapeamento por coleção: suporta tabelas dedicadas ou bot_config_state
      if (collection === 'bot_config') {
        const rows = await this.client.select('bot_config_state', 'select=id,revision,active_config,draft_config,updated_at&limit=1');
        return rows?.[0] || null;
      }

      if (collection === 'sectors_projection') {
        const rows = await this.client.select('runtime_projections', 'select=payload&key=eq.sectors_projection&limit=1');
        return rows?.[0]?.payload || null;
      }

      // Consulta padrão por external_key ou id
      const rows = await this.client.select(collection, `select=*&external_key=eq.${encodeURIComponent(key)}&limit=1`);
      if (rows?.[0]) return rows[0];

      const byId = await this.client.select(collection, `select=*&id=eq.${encodeURIComponent(key)}&limit=1`);
      return byId?.[0] || null;
    } catch (err) {
      this.logger.warn?.(`[storage:supabase] falha ao buscar ${collection}/${key}: ${err.message}`);
      if (this.fallback) return this.fallback.get(collection, key);
      throw err;
    }
  }

  async set(collection, key, value) {
    let fallbackPromise = null;
    if (this.fallback) {
      fallbackPromise = this.fallback.set(collection, key, value).catch(e => {
        this.logger.warn?.(`[storage:supabase] fallback local falhou para ${collection}/${key}: ${e.message}`);
      });
    }

    if (!this.enabled) {
      if (fallbackPromise) await fallbackPromise;
      return value;
    }

    try {
      if (collection === 'sectors_projection') {
        await this.client.upsert('runtime_projections', [{
          key: 'sectors_projection',
          payload: value,
          updated_at: new Date().toISOString()
        }], 'key');
        if (fallbackPromise) await fallbackPromise;
        return value;
      }

      await this.client.upsert(collection, [value]);
      if (fallbackPromise) await fallbackPromise;
      return value;
    } catch (err) {
      this.logger.warn?.(`[storage:supabase] falha ao gravar ${collection}/${key}: ${err.message}`);
      if (fallbackPromise) await fallbackPromise;
      // Não bloqueia em caso de falha remota se houver fallback local
      if (!this.fallback) throw err;
      return value;
    }
  }

  async delete(collection, key) {
    if (this.fallback) {
      await this.fallback.delete(collection, key).catch(() => {});
    }

    if (!this.enabled) return true;

    try {
      await this.client.request(collection, {
        method: 'DELETE',
        query: `external_key=eq.${encodeURIComponent(key)}`
      });
      return true;
    } catch (err) {
      this.logger.warn?.(`[storage:supabase] falha ao deletar ${collection}/${key}: ${err.message}`);
      return false;
    }
  }

  async health() {
    if (!this.enabled) {
      return { ok: false, adapter: 'supabase', reason: 'client_disabled' };
    }
    try {
      await this.client.select('bot_config_state', 'select=id&limit=1');
      return { ok: true, adapter: 'supabase' };
    } catch (err) {
      return { ok: false, adapter: 'supabase', error: err.message };
    }
  }
}
