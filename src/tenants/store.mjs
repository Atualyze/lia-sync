import fs from 'node:fs';
import path from 'node:path';

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
  constructor(filePath = path.resolve('./data/tenants.json')) {
    this.filePath = filePath;
    this.tenants = new Map([['default', { ...DEFAULT_TENANT }]]);
  }

  load() {
    if (!fs.existsSync(this.filePath)) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.tenants) ? raw.tenants : []);
      for (const item of list) {
        const id = sanitizeTenantId(item?.id);
        this.tenants.set(id, { ...DEFAULT_TENANT, ...item, id });
      }
    } catch {
      // mantém fallback default
    }
    return this;
  }

  save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = JSON.stringify({ tenants: this.list() }, null, 2);
    fs.writeFileSync(this.filePath, data, 'utf8');
  }

  list() {
    return Array.from(this.tenants.values());
  }

  get(id) {
    return this.tenants.get(sanitizeTenantId(id)) || null;
  }

  upsert(input = {}) {
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
    this.save();
    return next;
  }

  remove(id) {
    const clean = sanitizeTenantId(id);
    if (clean === 'default') return false;
    const deleted = this.tenants.delete(clean);
    if (deleted) this.save();
    return deleted;
  }
}
