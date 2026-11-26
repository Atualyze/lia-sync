import fs from 'node:fs';
import path from 'node:path';

const PROJECTION_KEY = 'lia_tenants';

const DEFAULT_TENANT = {
  id: 'default',
  name: 'Conta Principal',
  whatsappProvider: 'baileys',
  webhookToken: '',
  systemPrompt: '',
  knowledgeUrl: '',
  active: true,
};

export function sanitizeTenantId(raw) {
  const clean = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return clean || 'default';
}

export function resolveTenantFromRequest(req, u) {
  const parts = String(u?.pathname || '').split('/').filter(Boolean);
  // /webhook/manychat/:tenantId ou /webhook/ghl/:tenantId
  if (parts[0] === 'webhook' && ['manychat', 'ghl'].includes(parts[1]) && parts[2]) {
    return sanitizeTenantId(parts[2]);
  }
  const q = u?.searchParams?.get('tenant') || req?.headers?.['x-tenant-id'];
  return sanitizeTenantId(q || 'default');
}

export class TenantStore {
  constructor(filePath = path.resolve('./data/tenants.json'), { client = null } = {}) {
    this.filePath = filePath;
    this.client = client;
    this.tenants = new Map([['default', { ...DEFAULT_TENANT }]]);
  }

  _applyList(list) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const id = sanitizeTenantId(item?.id);
      this.tenants.set(id, { ...DEFAULT_TENANT, ...item, id });
    }
  }

  async load() {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from('runtime_projections')
          .select('payload')
          .eq('key', PROJECTION_KEY)
          .maybeSingle();
        if (!error && data?.payload?.tenants) {
          this._applyList(data.payload.tenants);
        }
      } catch {
        // mantém default em caso de erro transitório
      }
      return this;
    }

    if (!fs.existsSync(this.filePath)) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.tenants) ? raw.tenants : []);
      this._applyList(list);
    } catch {
      // mantém fallback default
    }
    return this;
  }

  async save() {
    const payload = { tenants: this.list() };
    if (this.client) {
      const { error } = await this.client
        .from('runtime_projections')
        .upsert({ key: PROJECTION_KEY, payload, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw new Error(`Falha ao salvar tenants no banco: ${error.message}`);
      return;
    }

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  list() {
    return Array.from(this.tenants.values());
  }

  get(id) {
    return this.tenants.get(sanitizeTenantId(id)) || null;
  }

  async upsert(input = {}) {
    const id = sanitizeTenantId(input.id || input.name);
    const prev = this.tenants.get(id) || { ...DEFAULT_TENANT, id, createdAt: new Date().toISOString() };
    const next = {
      ...prev,
      ...input,
      id,
      name: String(input.name || prev.name || id).trim().slice(0, 80),
      whatsappProvider: ['baileys', 'manychat', 'ghl', 'evolution'].includes(input.whatsappProvider)
        ? input.whatsappProvider
        : prev.whatsappProvider,
      updatedAt: new Date().toISOString(),
    };
    this.tenants.set(id, next);
    await this.save();
    return next;
  }

  async remove(id) {
    const clean = sanitizeTenantId(id);
    if (clean === 'default') return false;
    const deleted = this.tenants.delete(clean);
    if (deleted) await this.save();
    return deleted;
  }
}
