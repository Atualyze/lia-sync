import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Projeção de runtime dos setores do Chatwoot Lia.
 *
 * Fronteira: setores e triagem pertencem ao Chatwoot. Eles NÃO entram na
 * configuração publicada do Lia Sync (rascunho, validação, revisão e rollback),
 * para que nenhuma alteração de setor publique, por acidente, um rascunho
 * pendente de outra pessoa. Este módulo guarda apenas a última projeção
 * recebida pela ponte autenticada, em memória e em arquivo próprio.
 *
 * O texto do aviso ao cliente, telefones e campos administrativos de setor
 * nunca são copiados para cá: o motor precisa apenas de id, nome, descrição
 * e status ativo para classificar a triagem.
 */
// Limites do contrato da ponte. O produtor (Chatwoot Lia) corta exatamente nestes valores,
// portanto uma lista legítima nunca é rejeitada por divergência de tamanho.
export const MAX_SECTORS = 100;
export const MAX_ID = 60;
export const MAX_NAME = 120;
export const MAX_DESCRIPTION = 500;

export class SectorProjectionError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'SectorProjectionError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Normaliza e valida a lista recebida. Campos não permitidos são descartados.
 * @throws {SectorProjectionError} quando a lista é structuralmente inválida.
 */
export function normalizeSectors(sectors) {
  if (!Array.isArray(sectors)) throw new SectorProjectionError('invalid_sectors');
  if (sectors.length > MAX_SECTORS) throw new SectorProjectionError('too_many_sectors');
  const seen = new Set();
  const result = [];
  for (const item of sectors) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SectorProjectionError('invalid_sectors');
    const id = String(item.id ?? '').trim();
    const name = String(item.name ?? '').trim();
    if (!id || !name || id.length > MAX_ID || name.length > MAX_NAME) throw new SectorProjectionError('invalid_sectors');
    if (seen.has(id)) throw new SectorProjectionError('duplicate_sector_id');
    seen.add(id);
    const description = typeof item.description === 'string' ? item.description.trim().slice(0, MAX_DESCRIPTION) : '';
    result.push({ id, name, description, isActive: item.isActive !== false });
  }
  return result;
}

export class SectorProjection {
  constructor(file = path.resolve('./data/sectors-projection.json'), { now = () => Date.now(), logger = console, client = null, storageAdapter = null } = {}) {
    this.file = file;
    this.now = now;
    this.logger = logger;
    this.client = client;
    this.storageAdapter = storageAdapter;
    this.sectors = [];
    this.updatedAt = null;
    this.writing = null;
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.sectors = normalizeSectors(Array.isArray(raw.sectors) ? raw.sectors : []);
      this.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SectorProjectionError)) {
        this.logger.error?.(`[sectors] projeção local inválida: ${error.message}`);
      }
      this.sectors = [];
      this.updatedAt = null;
    }

    // Carrega projeção remota se disponível (multi-réplicas)
    if (this.client?.enabled || this.storageAdapter) {
      await this.syncRemote().catch(err => {
        this.logger.warn?.(`[sectors] sincronização remota inicial falhou; usando projeção local: ${err.message}`);
      });
    }

    return this;
  }

  async syncRemote() {
    if (this.storageAdapter) {
      const remote = await this.storageAdapter.get('sectors_projection', 'current');
      if (remote && Array.isArray(remote.sectors)) {
        const remoteTime = new Date(remote.updatedAt || 0).getTime();
        const localTime = new Date(this.updatedAt || 0).getTime();
        if (remoteTime >= localTime || !this.sectors.length) {
          this.sectors = normalizeSectors(remote.sectors);
          this.updatedAt = remote.updatedAt || new Date(this.now()).toISOString();
        }
      }
      return;
    }

    if (this.client?.enabled) {
      try {
        const rows = await this.client.select('runtime_projections', 'select=payload,updated_at&key=eq.sectors_projection&limit=1');
        const remote = rows?.[0]?.payload;
        if (remote && Array.isArray(remote.sectors)) {
          const remoteTime = new Date(remote.updatedAt || rows?.[0]?.updated_at || 0).getTime();
          const localTime = new Date(this.updatedAt || 0).getTime();
          if (remoteTime >= localTime || !this.sectors.length) {
            this.sectors = normalizeSectors(remote.sectors);
            this.updatedAt = remote.updatedAt || new Date(this.now()).toISOString();
          }
        }
      } catch (err) {
        this.logger.warn?.(`[sectors] leitura remota indisponível; usando projeção local: ${err.message}`);
      }
    }
  }

  /** Lista usada pelo motor. Sempre um array; nunca nulo. */
  list() {
    return Array.isArray(this.sectors) ? this.sectors : [];
  }

  active() {
    return this.list().filter(item => item.isActive);
  }

  status() {
    return { synced: Boolean(this.updatedAt), count: this.list().length, updatedAt: this.updatedAt };
  }

  /**
   * Substitui a projeção. Falha fechada: qualquer rejeição mantém a projeção
   * anterior intacta e nada é gravado em disco.
   */
  async replace(sectors) {
    const next = normalizeSectors(sectors);
    const previous = this.sectors;
    const previousUpdatedAt = this.updatedAt;
    this.sectors = next;
    this.updatedAt = new Date(this.now()).toISOString();
    try {
      await this.flush();
    } catch (error) {
      this.sectors = previous;
      this.updatedAt = previousUpdatedAt;
      throw new SectorProjectionError('sector_projection_persistence_unavailable', 503);
    }
    return this.status();
  }

  async flush() {
    const write = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ sectors: this.sectors, updatedAt: this.updatedAt }, null, 2));
      await fs.rename(tmp, this.file);

      if (this.storageAdapter) {
        await this.storageAdapter.set('sectors_projection', 'current', { sectors: this.sectors, updatedAt: this.updatedAt }).catch(err => {
          this.logger.warn?.(`[sectors] falha ao persistir no storage adapter: ${err.message}`);
        });
      } else if (this.client?.enabled) {
        try {
          await this.client.upsert('runtime_projections', [{
            key: 'sectors_projection',
            payload: { sectors: this.sectors, updatedAt: this.updatedAt },
            updated_at: new Date(this.now()).toISOString()
          }], 'key');
        } catch (err) {
          this.logger.warn?.(`[sectors] falha ao replicar projeção para o Supabase: ${err.message}`);
        }
      }
    };
    this.writing = (this.writing || Promise.resolve()).catch(() => {}).then(write).finally(() => { this.writing = null; });
    return this.writing;
  }
}
