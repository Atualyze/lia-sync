import crypto from 'node:crypto';
import { normalizePhone } from '../sessions.mjs';

/**
 * Store for prospecting lists, leads, and events.
 * Uses Supabase when configured, or an in-memory store for isolated unit tests.
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

  async createList({ name, source = 'csv', segment = '', consentBasis = '', dailyCap = 20, status = 'paused' }) {
    const now = new Date().toISOString();
    if (!this.client) {
      const id = crypto.randomUUID();
      const list = {
        id,
        name,
        source,
        segment,
        consent_basis: consentBasis,
        status,
        daily_cap: dailyCap,
        warmup_started_at: status === 'active' ? now : null,
        created_at: now,
        updated_at: now
      };
      this.mem.lists.set(id, list);
      return list;
    }
    const { data, error } = await this.client
      .from('prospect_lists')
      .insert({
        name,
        source,
        segment,
        consent_basis: consentBasis,
        status,
        daily_cap: dailyCap,
        warmup_started_at: status === 'active' ? now : null
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async addLeads(listId, leads = []) {
    if (!leads.length) return [];
    const now = new Date().toISOString();
    if (!this.client) {
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
    const { data, error } = await this.client
      .from('prospect_leads')
      .upsert(payload, { onConflict: 'list_id,phone', ignoreDuplicates: true })
      .select();
    if (error) throw error;
    return data || [];
  }

  async listDueLeads({ limit = 10, now = new Date() } = {}) {
    const nowIso = now.toISOString();
    if (!this.client) {
      const activeLists = new Set(
        [...this.mem.lists.values()].filter(l => l.status === 'active').map(l => l.id)
      );
      return [...this.mem.leads.values()]
        .filter(l =>
          activeLists.has(l.list_id)
          && ['new', 'queued'].includes(l.status)
          && !l.claim_token
          && (!l.next_action_at || l.next_action_at <= nowIso)
        )
        .slice(0, limit)
        .map(l => ({ ...l, list: this.mem.lists.get(l.list_id) }));
    }

    const { data, error } = await this.client
      .from('prospect_leads')
      .select('*, list:prospect_lists!inner(*)')
      .in('status', ['new', 'queued'])
      .is('claim_token', null)
      .eq('list.status', 'active')
      .lte('next_action_at', nowIso)
      .order('next_action_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }

  async claimLead(leadId) {
    const token = crypto.randomUUID();
    const now = new Date().toISOString();
    if (!this.client) {
      const lead = this.mem.leads.get(leadId);
      if (!lead || lead.claim_token || !['new', 'queued'].includes(lead.status)) return null;
      lead.claim_token = token;
      lead.claimed_at = now;
      lead.status = 'queued';
      lead.updated_at = now;
      return { ...lead };
    }

    const { data, error } = await this.client
      .from('prospect_leads')
      .update({ claim_token: token, claimed_at: now, status: 'queued', updated_at: now })
      .eq('id', leadId)
      .is('claim_token', null)
      .in('status', ['new', 'queued'])
      .select()
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async releaseClaim(leadId, claimToken, updates = {}) {
    const now = new Date().toISOString();
    if (!this.client) {
      const lead = this.mem.leads.get(leadId);
      if (!lead || lead.claim_token !== claimToken) return null;
      Object.assign(lead, updates, { claim_token: null, claimed_at: null, updated_at: now });
      return { ...lead };
    }
    const { data, error } = await this.client
      .from('prospect_leads')
      .update({ ...updates, claim_token: null, claimed_at: null, updated_at: now })
      .eq('id', leadId)
      .eq('claim_token', claimToken)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async countSentToday({ listId = null, sinceIso } = {}) {
    if (!this.client) {
      return this.mem.events.filter(e =>
        e.event_type === 'sent'
        && (!listId || e.list_id === listId)
        && (!sinceIso || e.created_at >= sinceIso)
      ).length;
    }
    let query = this.client
      .from('prospect_events')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'sent')
      .gte('created_at', sinceIso);
    if (listId) query = query.eq('list_id', listId);
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
  }

  async recordEvent({ listId = null, leadId = null, phone, eventType, stage = 0, detail = {} }) {
    const now = new Date().toISOString();
    if (!this.client) {
      const ev = { id: crypto.randomUUID(), list_id: listId, lead_id: leadId, phone, event_type: eventType, stage, detail, created_at: now };
      this.mem.events.push(ev);
      return ev;
    }
    const { data, error } = await this.client
      .from('prospect_events')
      .insert({ list_id: listId, lead_id: leadId, phone, event_type: eventType, stage, detail })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async markOptedOutByPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return 0;
    const now = new Date().toISOString();
    if (!this.client) {
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
    const { data, error } = await this.client
      .from('prospect_leads')
      .update({ status: 'opted_out', claim_token: null, next_action_at: null, updated_at: now })
      .eq('phone', normalized)
      .not('status', 'in', '("opted_out","stopped")')
      .select('id, list_id');
    if (error) throw error;
    for (const row of data || []) {
      await this.recordEvent({ listId: row.list_id, leadId: row.id, phone: normalized, eventType: 'optout' });
    }
    return (data || []).length;
  }
}
