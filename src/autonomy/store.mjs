import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_SNAPSHOT = () => ({
  policies: {},
  decisions: [],
  salesStates: {},
  notifications: []
});

const TABLES = [
  'lia_org_autonomy_policies',
  'lia_autonomy_decisions',
  'lia_sales_states',
  'lia_proactive_notifications'
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Persistência durável da camada de Autonomia (Supabase backend-only + fallback local atômico).
 */
export class LiaAutonomyStore {
  constructor({
    client = null,
    filePath = './data/lia-autonomy.json',
    allowLocalFallback = false,
    logger = console,
    now = () => Date.now()
  } = {}) {
    this.client = client;
    this.filePath = filePath;
    this.allowLocalFallback = allowLocalFallback === true;
    this.logger = logger;
    this.now = now;
    this.mode = 'local';
    this.remoteError = null;
    this.localCorrupt = false;
    this.loaded = false;
    this.writing = Promise.resolve();
    this.snapshot = DEFAULT_SNAPSHOT();
  }

  get remoteEnabled() {
    return Boolean(this.client?.enabled && this.mode === 'supabase');
  }

  get available() {
    if (this.mode === 'unavailable') return false;
    if (!this.remoteEnabled && this.localCorrupt) return false;
    return this.loaded;
  }

  _serial(fn) {
    this.writing = this.writing.catch(() => {}).then(fn);
    return this.writing;
  }

  async _readLocalFile() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error('invalid_autonomy_snapshot');
      return {
        policies: isPlainObject(parsed.policies) ? parsed.policies : {},
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        salesStates: isPlainObject(parsed.salesStates) ? parsed.salesStates : {},
        notifications: Array.isArray(parsed.notifications) ? parsed.notifications : []
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return DEFAULT_SNAPSHOT();
      throw error;
    }
  }

  async _saveLocal() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const payload = {
      ...this.snapshot,
      decisions: this.snapshot.decisions.slice(-500),
      notifications: this.snapshot.notifications.slice(-500)
    };
    try {
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async load() {
    this.remoteError = null;
    this.localCorrupt = false;
    if (this.client?.enabled) {
      try {
        await Promise.all(TABLES.map(tbl => this.client.select(tbl, 'select=*&limit=1')));
        this.mode = 'supabase';
        this.loaded = true;
        return this;
      } catch (error) {
        this.remoteError = String(error?.code || error?.name || 'lia_autonomy_supabase_unavailable');
        if (!this.allowLocalFallback) {
          this.mode = 'unavailable';
          this.loaded = false;
          this.logger.error?.(`[lia-autonomy] Supabase indisponível (${this.remoteError}); autonomia em modo fail-closed.`);
          return this;
        }
        this.logger.warn?.(`[lia-autonomy] Supabase indisponível (${this.remoteError}); usando fallback local explícito.`);
      }
    }
    try {
      this.snapshot = await this._readLocalFile();
      this.mode = 'local';
      this.loaded = true;
    } catch (error) {
      this.localCorrupt = true;
      this.mode = 'unavailable';
      this.loaded = false;
      this.logger.error?.(`[lia-autonomy] arquivo local corrompido (${error?.code || error?.name || 'corrupt'}); operação bloqueada.`);
    }
    return this;
  }

  _assertAvailable() {
    if (!this.available) throw new Error('lia_autonomy_store_unavailable');
  }

  async listPolicies() {
    this._assertAvailable();
    if (this.remoteEnabled) {
      const rows = await this.client.select('lia_org_autonomy_policies', 'select=*&limit=100');
      return Array.isArray(rows) ? rows : [];
    }
    return Object.values(this.snapshot.policies).map(clone);
  }

  async savePolicy(policy) {
    this._assertAvailable();
    const row = {
      tenant_id: String(policy.tenant_id || 'default'),
      autonomy_level: policy.autonomy_level || 'assisted',
      allowed_actions: Array.isArray(policy.allowed_actions) ? policy.allowed_actions : [],
      approval_policy: policy.approval_policy || {},
      daily_limits: policy.daily_limits || {},
      business_hours: policy.business_hours || {},
      communication_policy: policy.communication_policy || {},
      learning_policy: policy.learning_policy || {},
      experiment_policy: policy.experiment_policy || {},
      updated_at: new Date(this.now()).toISOString()
    };
    if (this.remoteEnabled) {
      await this.client.upsert('lia_org_autonomy_policies', [row], 'tenant_id');
      return clone(row);
    }
    return this._serial(async () => {
      this.snapshot.policies[row.tenant_id] = clone(row);
      await this._saveLocal();
      return clone(row);
    });
  }

  async saveDecision(entry) {
    this._assertAvailable();
    const row = {
      id: entry.id || crypto.randomUUID(),
      tenant_id: String(entry.tenant_id || 'default'),
      event_id: entry.event?.id || null,
      goal_id: entry.goal?.id || null,
      decision_action: String(entry.proposed_action || 'observe'),
      why: String(entry.why || ''),
      proposed_action: String(entry.proposed_action || 'observe'),
      expected_outcome: String(entry.expected_outcome || ''),
      risk: ['low', 'medium', 'high', 'critical'].includes(entry.risk) ? entry.risk : 'medium',
      authorization_decision: String(entry.authorization?.decision || 'unknown'),
      confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0.5,
      verification_plan: String(entry.verification_plan || ''),
      verification_status: ['pending', 'confirmed', 'failed', 'uncertain', 'partial'].includes(entry.verification?.status)
        ? entry.verification.status
        : 'pending',
      audit_chain: {
        context: entry.context || {},
        authorization: entry.authorization || {},
        verification: entry.verification || null,
        outcome: entry.outcome || null
      },
      created_at: entry.recorded_at || new Date(this.now()).toISOString()
    };
    if (this.remoteEnabled) {
      await this.client.upsert('lia_autonomy_decisions', [row], 'id');
      return clone(row);
    }
    return this._serial(async () => {
      const idx = this.snapshot.decisions.findIndex(d => d.id === row.id);
      if (idx >= 0) this.snapshot.decisions[idx] = clone(row);
      else this.snapshot.decisions.push(clone(row));
      await this._saveLocal();
      return clone(row);
    });
  }

  async listDecisions({ tenantId = null, limit = 50 } = {}) {
    this._assertAvailable();
    if (this.remoteEnabled) {
      const filter = tenantId ? `&tenant_id=eq.${encodeURIComponent(tenantId)}` : '';
      const rows = await this.client.select('lia_autonomy_decisions', `select=*${filter}&order=created_at.desc&limit=${Math.max(1, Math.min(200, Number(limit) || 50))}`);
      return Array.isArray(rows) ? rows : [];
    }
    const items = tenantId
      ? this.snapshot.decisions.filter(d => d.tenant_id === tenantId)
      : this.snapshot.decisions;
    return clone(items.slice(-limit).reverse());
  }

  async saveSalesState(state) {
    this._assertAvailable();
    const row = {
      id: String(state.id),
      tenant_id: String(state.tenant_id || 'default'),
      subject: String(state.subject || ''),
      stage: state.stage || 'new',
      score: Math.max(0, Math.min(100, Math.round(Number(state.score) || 0))),
      score_factors: state.score_factors || {},
      next_action: String(state.next_action || ''),
      transitions: Array.isArray(state.transitions) ? state.transitions.slice(-50) : [],
      metadata: state.metadata || {},
      updated_at: new Date(this.now()).toISOString()
    };
    if (this.remoteEnabled) {
      await this.client.upsert('lia_sales_states', [row], 'id');
      return clone(row);
    }
    return this._serial(async () => {
      this.snapshot.salesStates[row.id] = clone(row);
      await this._saveLocal();
      return clone(row);
    });
  }

  async hasProactiveNotification({ deduplicationKey } = {}) {
    this._assertAvailable();
    const key = String(deduplicationKey || '').trim().slice(0, 200);
    if (!key) return false;
    if (this.remoteEnabled) {
      const rows = await this.client.select(
        'lia_proactive_notifications',
        `select=id&deduplication_key=eq.${encodeURIComponent(key)}&limit=1`
      );
      return Array.isArray(rows) && rows.length > 0;
    }
    return this.snapshot.notifications.some(item => item.deduplication_key === key);
  }

  async claimProactiveNotification({ tenantId = 'default', deduplicationKey, subject = 'owner', reason = 'daily_review' } = {}) {
    this._assertAvailable();
    const key = String(deduplicationKey || '').trim().slice(0, 200);
    if (!key) throw new Error('proactive_notification_deduplication_key_required');
    const row = {
      id: crypto.randomUUID(),
      tenant_id: String(tenantId || 'default'),
      deduplication_key: key,
      subject: String(subject || 'owner').slice(0, 160),
      reason: String(reason || 'daily_review').slice(0, 120),
      status: 'deferred',
      created_at: new Date(this.now()).toISOString()
    };
    if (this.remoteEnabled) {
      const inserted = await this.client.request('lia_proactive_notifications', {
        method: 'POST',
        query: 'on_conflict=deduplication_key',
        body: [row],
        prefer: 'resolution=ignore-duplicates,return=representation'
      });
      return Array.isArray(inserted) && inserted.some(item => item?.deduplication_key === key);
    }
    return this._serial(async () => {
      if (this.snapshot.notifications.some(item => item.deduplication_key === key)) return false;
      this.snapshot.notifications.push(clone(row));
      await this._saveLocal();
      return true;
    });
  }

  async finalizeProactiveNotification({ deduplicationKey, status = 'sent' } = {}) {
    this._assertAvailable();
    const key = String(deduplicationKey || '').trim().slice(0, 200);
    if (!key) throw new Error('proactive_notification_deduplication_key_required');
    const safeStatus = ['sent', 'suppressed', 'deferred', 'failed'].includes(status) ? status : 'failed';
    if (this.remoteEnabled) {
      await this.client.patch(
        'lia_proactive_notifications',
        `deduplication_key=eq.${encodeURIComponent(key)}`,
        { status: safeStatus },
        { returnRepresentation: false }
      );
      return true;
    }
    return this._serial(async () => {
      const row = this.snapshot.notifications.find(item => item.deduplication_key === key);
      if (!row) return false;
      row.status = safeStatus;
      await this._saveLocal();
      return true;
    });
  }

  async recordProactiveNotification({ tenantId = 'default', deduplicationKey, subject = 'owner', reason = 'daily_review', status = 'sent' } = {}) {
    this._assertAvailable();
    const row = {
      id: crypto.randomUUID(),
      tenant_id: String(tenantId || 'default'),
      deduplication_key: String(deduplicationKey || `proact:${crypto.randomUUID()}`).slice(0, 200),
      subject: String(subject || 'owner').slice(0, 160),
      reason: String(reason || 'daily_review').slice(0, 120),
      status: ['sent', 'suppressed', 'deferred', 'failed'].includes(status) ? status : 'sent',
      created_at: new Date(this.now()).toISOString()
    };
    if (this.remoteEnabled) {
      await this.client.upsert('lia_proactive_notifications', [row], 'deduplication_key').catch(() => {});
      return clone(row);
    }
    return this._serial(async () => {
      if (!this.snapshot.notifications.some(n => n.deduplication_key === row.deduplication_key)) {
        this.snapshot.notifications.push(clone(row));
        await this._saveLocal();
      }
      return clone(row);
    });
  }
}
