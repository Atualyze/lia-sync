import crypto from 'node:crypto';
import { normalizePhone } from '../sessions.mjs';

/**
 * Store for prospecting lists, leads, and events.
 * Uses Lia Sync's SupabaseRestClient when enabled, or an in-memory store for isolated unit tests.
 */
export class ProspectLeadStore {
  constructor({ client = null } = {}) {
    this.client = client;
    this.mem = {
      lists: new Map(),
      leads: new Map(),
      events: []
    };
  }

  get remoteEnabled() {
    return Boolean(this.client?.enabled && typeof this.client?.request === 'function');
  }

  async createList({ name, source = 'csv', segment = '', consentBasis = '', dailyCap = 20, status = 'paused', startAt = null, endAt = null }) {
    const now = new Date().toISOString();
    const startIso = startAt ? new Date(startAt).toISOString() : null;
    const endIso = endAt ? new Date(endAt).toISOString() : null;

    if (!this.remoteEnabled) {
      const id = crypto.randomUUID();
      const list = {
        id,
        name,
        source,
        segment,
        consent_basis: consentBasis,
        status,
        daily_cap: dailyCap,
        start_at: startIso,
        end_at: endIso,
        warmup_started_at: status === 'active' ? now : null,
        created_at: now,
        updated_at: now
      };
      this.mem.lists.set(id, list);
      return list;
    }

    const rows = await this.client.request('prospect_lists', {
      method: 'POST',
      body: {
        name,
        source,
        segment,
        consent_basis: consentBasis,
        status,
        daily_cap: dailyCap,
        start_at: startIso,
        end_at: endIso,
        warmup_started_at: status === 'active' ? now : null
      },
      prefer: 'return=representation'
    });
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async addLeads(listId, leads = []) {
    if (!leads.length) return [];
    const now = new Date().toISOString();
    if (!this.remoteEnabled) {
      const inserted = [];
      for (const item of leads) {
        const phone = normalizePhone(item.phone);
        const dup = [...this.mem.leads.values()].find(l => l.list_id === listId && l.phone === phone);
        if (dup) continue;
        const row = {
          id: crypto.randomUUID(),
          list_id: listId,
          phone,
          name: item.name || '',
          context: item.context || {},
          status: 'new',
          stage: 0,
          next_action_at: now,
          last_contacted_at: null,
          claim_token: null,
          claimed_at: null,
          attempts: 0,
          last_error: null,
          created_at: now,
          updated_at: now
        };
        this.mem.leads.set(row.id, row);
        inserted.push(row);
      }
      return inserted;
    }

    const payload = leads.map(item => ({
      list_id: listId,
      phone: normalizePhone(item.phone),
      name: item.name || '',
      context: item.context || {},
      status: 'new',
      stage: 0,
      next_action_at: now
    }));
    const rows = await this.client.request('prospect_leads', {
      method: 'POST',
      query: 'on_conflict=list_id,phone',
      body: payload,
      prefer: 'resolution=ignore-duplicates,return=representation'
    });
    return Array.isArray(rows) ? rows : [];
  }

  async listDueLeads({ limit = 10, now = new Date() } = {}) {
    const nowIso = now.toISOString();
    const isListWithinDates = list => {
      if (!list || list.status !== 'active') return false;
      if (list.start_at && new Date(list.start_at) > now) return false;
      if (list.end_at && new Date(list.end_at) < now) return false;
      return true;
    };

    if (!this.remoteEnabled) {
      const activeLists = new Map(
        [...this.mem.lists.values()].filter(isListWithinDates).map(l => [l.id, l])
      );
      return [...this.mem.leads.values()]
        .filter(l =>
          activeLists.has(l.list_id)
          && ['new', 'queued'].includes(l.status)
          && !l.claim_token
          && (!l.next_action_at || l.next_action_at <= nowIso)
        )
        .slice(0, limit)
        .map(l => ({ ...l, list: activeLists.get(l.list_id) }));
    }

    const lists = await this.client.select('prospect_lists', 'select=*&status=eq.active');
    const eligibleLists = new Map((lists || []).filter(isListWithinDates).map(l => [l.id, l]));
    if (!eligibleLists.size) return [];

    const listIds = [...eligibleLists.keys()].map(id => `"${id}"`).join(',');
    const leads = await this.client.select(
      'prospect_leads',
      `select=*&list_id=in.(${listIds})&status=in.(new,queued)&claim_token=is.null&next_action_at=lte.${encodeURIComponent(nowIso)}&order=next_action_at.asc&limit=${limit}`
    );
    return (leads || []).map(l => ({ ...l, list: eligibleLists.get(l.list_id) }));
  }

  async claimLead(leadId) {
    const token = crypto.randomUUID();
    const now = new Date().toISOString();
    if (!this.remoteEnabled) {
      const lead = this.mem.leads.get(leadId);
      if (!lead || lead.claim_token || !['new', 'queued'].includes(lead.status)) return null;
      lead.claim_token = token;
      lead.claimed_at = now;
      lead.status = 'queued';
      lead.updated_at = now;
      return { ...lead };
    }

    const rows = await this.client.request('prospect_leads', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(leadId)}&claim_token=is.null&status=in.(new,queued)`,
      body: { claim_token: token, claimed_at: now, status: 'queued', updated_at: now },
      prefer: 'return=representation'
    });
    return Array.isArray(rows) ? (rows[0] || null) : null;
  }

  async updateList(listId, { name, segment, dailyCap, startAt, endAt } = {}) {
    const now = new Date().toISOString();
    const patch = { updated_at: now };
    if (name !== undefined) patch.name = String(name).trim();
    if (segment !== undefined) patch.segment = String(segment).trim();
    if (dailyCap !== undefined) patch.daily_cap = Math.max(1, Math.min(500, Number(dailyCap) || 20));
    if (startAt !== undefined) patch.start_at = startAt ? new Date(startAt).toISOString() : null;
    if (endAt !== undefined) patch.end_at = endAt ? new Date(endAt).toISOString() : null;

    if (!this.remoteEnabled) {
      const list = this.mem.lists.get(listId);
      if (!list) return null;
      Object.assign(list, patch);
      return { ...list };
    }

    const rows = await this.client.request('prospect_lists', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(listId)}`,
      body: patch,
      prefer: 'return=representation'
    });
    return Array.isArray(rows) ? (rows[0] || null) : null;
  }

  async releaseClaim(leadId, claimToken, updates = {}) {
    const now = new Date().toISOString();
    if (!this.remoteEnabled) {
      const lead = this.mem.leads.get(leadId);
      if (!lead || lead.claim_token !== claimToken) return null;
      Object.assign(lead, updates, { claim_token: null, claimed_at: null, updated_at: now });
      return { ...lead };
    }

    const rows = await this.client.request('prospect_leads', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(leadId)}&claim_token=eq.${encodeURIComponent(claimToken)}`,
      body: { ...updates, claim_token: null, claimed_at: null, updated_at: now },
      prefer: 'return=representation'
    });
    return Array.isArray(rows) ? (rows[0] || null) : null;
  }

  async updateList(listId, { name, segment, dailyCap, startAt, endAt } = {}) {
    const now = new Date().toISOString();
    const patch = { updated_at: now };
    if (name !== undefined) patch.name = String(name).trim();
    if (segment !== undefined) patch.segment = String(segment).trim();
    if (dailyCap !== undefined) patch.daily_cap = Math.max(1, Math.min(500, Number(dailyCap) || 20));
    if (startAt !== undefined) patch.start_at = startAt ? new Date(startAt).toISOString() : null;
    if (endAt !== undefined) patch.end_at = endAt ? new Date(endAt).toISOString() : null;

    if (!this.remoteEnabled) {
      const list = this.mem.lists.get(listId);
      if (!list) return null;
      Object.assign(list, patch);
      return { ...list };
    }

    const rows = await this.client.request('prospect_lists', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(listId)}`,
      body: patch,
      prefer: 'return=representation'
    });
    return Array.isArray(rows) ? (rows[0] || null) : null;
  }

  async countSentToday({ listId = null, sinceIso } = {}) {
    if (!this.remoteEnabled) {
      return this.mem.events.filter(e =>
        e.event_type === 'sent'
        && (!listId || e.list_id === listId)
        && (!sinceIso || e.created_at >= sinceIso)
      ).length;
    }

    const parts = ['select=id', 'event_type=eq.sent'];
    if (sinceIso) parts.push(`created_at=gte.${encodeURIComponent(sinceIso)}`);
    if (listId) parts.push(`list_id=eq.${encodeURIComponent(listId)}`);
    const rows = await this.client.select('prospect_events', parts.join('&'));
    return Array.isArray(rows) ? rows.length : 0;
  }

  async recordEvent({ listId = null, leadId = null, phone, eventType, stage = 0, detail = {} }) {
    const now = new Date().toISOString();
    if (!this.remoteEnabled) {
      const ev = { id: crypto.randomUUID(), list_id: listId, lead_id: leadId, phone, event_type: eventType, stage, detail, created_at: now };
      this.mem.events.push(ev);
      return ev;
    }

    await this.client.insert('prospect_events', {
      list_id: listId,
      lead_id: leadId,
      phone,
      event_type: eventType,
      stage,
      detail
    });
    return { list_id: listId, lead_id: leadId, phone, event_type: eventType, stage, detail };
  }

  async markOptedOutByPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return 0;
    const now = new Date().toISOString();
    if (!this.remoteEnabled) {
      let updated = 0;
      for (const lead of this.mem.leads.values()) {
        if (lead.phone === normalized && !['opted_out', 'stopped'].includes(lead.status)) {
          lead.status = 'opted_out';
          lead.claim_token = null;
          lead.next_action_at = null;
          lead.updated_at = now;
          updated += 1;
        }
      }
      if (updated > 0) {
        await this.recordEvent({ phone: normalized, eventType: 'optout', detail: { source: 'whatsapp-inbound' } });
      }
      return updated;
    }

    const rows = await this.client.request('prospect_leads', {
      method: 'PATCH',
      query: `phone=eq.${encodeURIComponent(normalized)}&status=not.in.(opted_out,stopped)`,
      body: { status: 'opted_out', claim_token: null, next_action_at: null, updated_at: now },
      prefer: 'return=representation'
    });
    for (const row of rows || []) {
      await this.recordEvent({ listId: row.list_id, leadId: row.id, phone: normalized, eventType: 'optout' });
    }
    return Array.isArray(rows) ? rows.length : 0;
  }

  async setListStatus(listId, status) {
    if (!['active', 'paused', 'stopped', 'completed'].includes(status)) {
      throw new Error('Status de lista inválido.');
    }
    const now = new Date().toISOString();
    if (!this.remoteEnabled) {
      const list = this.mem.lists.get(listId);
      if (!list) return null;
      list.status = status;
      if (status === 'active' && !list.warmup_started_at) {
        list.warmup_started_at = now;
      }
      list.updated_at = now;
      return { ...list };
    }

    const existingRows = await this.client.select('prospect_lists', `select=id,warmup_started_at&id=eq.${encodeURIComponent(listId)}&limit=1`);
    const existing = existingRows?.[0];
    if (!existing) return null;

    const patch = {
      status,
      updated_at: now,
      ...(status === 'active' && !existing.warmup_started_at ? { warmup_started_at: now } : {})
    };
    const rows = await this.client.request('prospect_lists', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(listId)}`,
      body: patch,
      prefer: 'return=representation'
    });
    return Array.isArray(rows) ? (rows[0] || null) : null;
  }

  async updateList(listId, { name, segment, dailyCap, startAt, endAt } = {}) {
    const now = new Date().toISOString();
    const patch = { updated_at: now };
    if (name !== undefined) patch.name = String(name).trim();
    if (segment !== undefined) patch.segment = String(segment).trim();
    if (dailyCap !== undefined) patch.daily_cap = Math.max(1, Math.min(500, Number(dailyCap) || 20));
    if (startAt !== undefined) patch.start_at = startAt ? new Date(startAt).toISOString() : null;
    if (endAt !== undefined) patch.end_at = endAt ? new Date(endAt).toISOString() : null;

    if (!this.remoteEnabled) {
      const list = this.mem.lists.get(listId);
      if (!list) return null;
      Object.assign(list, patch);
      return { ...list };
    }

    const rows = await this.client.request('prospect_lists', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(listId)}`,
      body: patch,
      prefer: 'return=representation'
    });
    return Array.isArray(rows) ? (rows[0] || null) : null;
  }

  async listListsWithStats({ limit = 30 } = {}) {
    if (!this.remoteEnabled) {
      return [...this.mem.lists.values()]
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit)
        .map(list => {
          const leads = [...this.mem.leads.values()].filter(l => l.list_id === list.id);
          return {
            ...list,
            stats: {
              total: leads.length,
              new: leads.filter(l => l.status === 'new').length,
              contacted: leads.filter(l => l.status === 'contacted').length,
              replied: leads.filter(l => l.status === 'replied').length,
              opted_out: leads.filter(l => l.status === 'opted_out').length,
              failed: leads.filter(l => l.status === 'failed').length
            }
          };
        });
    }

    const lists = await this.client.select('prospect_lists', `select=*&order=created_at.desc&limit=${limit}`);
    if (!lists?.length) return [];

    const listIds = lists.map(l => `"${l.id}"`).join(',');
    const leads = await this.client.select('prospect_leads', `select=list_id,status&list_id=in.(${listIds})`);

    const byList = new Map();
    for (const row of leads || []) {
      const bucket = byList.get(row.list_id) || { total: 0, new: 0, contacted: 0, replied: 0, opted_out: 0, failed: 0 };
      bucket.total += 1;
      if (row.status in bucket) bucket[row.status] += 1;
      byList.set(row.list_id, bucket);
    }

    return lists.map(list => ({
      ...list,
      stats: byList.get(list.id) || { total: 0, new: 0, contacted: 0, replied: 0, opted_out: 0, failed: 0 }
    }));
  }
}
