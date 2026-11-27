const VALID_OPERATING_MODES = new Set(['passive', 'assisted', 'proactive_safe']);
const VALID_STATUSES = new Set([
  'idle', 'observing', 'evaluating', 'planning', 'working', 'waiting', 'blocked', 'needs_human', 'recovering'
]);

const DEFAULT_PRINCIPLES = Object.freeze([
  'Transparência operacional: nunca afirmar que uma ação foi executada sem confirmação verificável.',
  'Segurança acima da autonomia: respeitar políticas de ferramentas, aprovações humanas, Pix e supressão de outbound.',
  'Continuidade determinística: manter estado persistente separado de sessões e histórico de mensagens.',
  'Economia de recursos: acordar por eventos, prazos e objetivos sem loops contínuos de LLM.'
]);

function normalizeIdentityRecord(raw = {}, { nowIso, defaultName = 'Lia' } = {}) {
  const baseIdentity = raw.identity && typeof raw.identity === 'object' && !Array.isArray(raw.identity)
    ? raw.identity
    : {};
  return {
    id: 'primary',
    identity: {
      name: String(baseIdentity.name || defaultName).trim().slice(0, 80) || 'Lia',
      version: String(baseIdentity.version || '3.5.0').trim().slice(0, 40),
      description: String(baseIdentity.description || 'Runtime operacional persistente da assistente Lia Sync.').trim().slice(0, 400)
    },
    role: String(raw.role || 'assistente_operacional').trim().slice(0, 80) || 'assistente_operacional',
    principles: Array.isArray(raw.principles) && raw.principles.length
      ? raw.principles.map(item => String(item || '').trim().slice(0, 280)).filter(Boolean).slice(0, 20)
      : [...DEFAULT_PRINCIPLES],
    operating_mode: VALID_OPERATING_MODES.has(raw.operating_mode) ? raw.operating_mode : 'assisted',
    owner_preferences: raw.owner_preferences && typeof raw.owner_preferences === 'object' && !Array.isArray(raw.owner_preferences)
      ? { ...raw.owner_preferences }
      : {},
    current_status: VALID_STATUSES.has(raw.current_status) ? raw.current_status : 'idle',
    active_objectives: Array.isArray(raw.active_objectives) ? raw.active_objectives.slice(0, 50) : [],
    active_commitments: Array.isArray(raw.active_commitments) ? raw.active_commitments.slice(0, 50) : [],
    watched_items: Array.isArray(raw.watched_items) ? raw.watched_items.slice(0, 100) : [],
    metadata: raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
      ? { ...raw.metadata }
      : {},
    created_at: raw.created_at || nowIso,
    updated_at: raw.updated_at || nowIso
  };
}

export class LiaIdentityStore {
  constructor({ store, getBotConfig = () => ({}), now = () => Date.now() } = {}) {
    this.store = store;
    this.getBotConfig = getBotConfig;
    this.now = now;
  }

  _defaultName() {
    const cfg = this.getBotConfig?.() || {};
    return String(cfg?.identity?.botName || cfg?.botName || 'Lia').trim() || 'Lia';
  }

  async ensure() {
    const existing = await this.store.getIdentity();
    const nowIso = new Date(this.now()).toISOString();
    if (existing) return normalizeIdentityRecord(existing, { nowIso, defaultName: this._defaultName() });
    const initial = normalizeIdentityRecord({}, { nowIso, defaultName: this._defaultName() });
    return this.store.saveIdentity(initial);
  }

  async get() {
    return this.ensure();
  }

  async update(patch = {}) {
    const current = await this.ensure();
    const nowIso = new Date(this.now()).toISOString();
    const merged = normalizeIdentityRecord({
      ...current,
      ...patch,
      identity: patch.identity ? { ...current.identity, ...patch.identity } : current.identity,
      owner_preferences: patch.owner_preferences
        ? { ...current.owner_preferences, ...patch.owner_preferences }
        : current.owner_preferences,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      created_at: current.created_at,
      updated_at: nowIso
    }, { nowIso, defaultName: this._defaultName() });
    return this.store.saveIdentity(merged);
  }

  async syncOperationalView({ currentStatus, activeObjectives, activeCommitments } = {}) {
    const patch = {};
    if (currentStatus && VALID_STATUSES.has(currentStatus)) patch.current_status = currentStatus;
    if (Array.isArray(activeObjectives)) {
      patch.active_objectives = activeObjectives.slice(0, 50).map(goal => ({
        id: goal.id,
        title: goal.title,
        priority: goal.priority,
        progress: goal.progress
      }));
    }
    if (Array.isArray(activeCommitments)) {
      patch.active_commitments = activeCommitments.slice(0, 50).map(c => ({
        id: c.id,
        title: c.title,
        due_at: c.due_at,
        status: c.status
      }));
    }
    return this.update(patch);
  }

  async watchItem(item = {}) {
    const current = await this.ensure();
    const id = String(item.id || item.key || '').trim();
    if (!id) throw new Error('watched_item_id_required');
    const normalized = {
      id: id.slice(0, 120),
      kind: String(item.kind || 'generic').trim().slice(0, 60),
      label: String(item.label || id).trim().slice(0, 160),
      added_at: new Date(this.now()).toISOString()
    };
    const next = current.watched_items.filter(entry => entry.id !== normalized.id);
    next.push(normalized);
    return this.update({ watched_items: next.slice(-100) });
  }

  async unwatchItem(id) {
    const current = await this.ensure();
    const safeId = String(id || '').trim();
    const next = current.watched_items.filter(entry => entry.id !== safeId);
    return this.update({ watched_items: next });
  }
}

export { VALID_OPERATING_MODES, VALID_STATUSES, DEFAULT_PRINCIPLES };
