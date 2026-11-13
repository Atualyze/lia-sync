import crypto from 'node:crypto';
import { normalizePhone } from './sessions.mjs';

const MAX_RECIPIENTS = 5000;
const MIN_DELAY_SECONDS = 3;
const DEFAULT_RATE_LIMIT = 10;

const nowIso = () => new Date().toISOString();
const asId = () => crypto.randomUUID();
const statusFor = row => String(row?.status || '').toLowerCase();
const publicRecipient = row => ({
  id: row.id,
  phone: row.phone,
  name: row.name || 'Cliente',
  status: String(row.status || 'pending').toUpperCase(),
  error: row.error || undefined,
  sentAt: row.sent_at || undefined
});

export class CampaignStore {
  constructor({ client, sender, logger = console, now = nowIso, maxPerRun = DEFAULT_RATE_LIMIT } = {}) {
    this.client = client;
    this.sender = sender;
    this.logger = logger;
    this.now = now;
    this.maxPerRun = Math.max(1, Number(maxPerRun) || DEFAULT_RATE_LIMIT);
  }
  get enabled() { return Boolean(this.client?.enabled); }
  async create({ title, message, recipients, minDelay = 6, maxDelay = 15, actorId = null, idempotencyKey }) {
    if (!this.enabled) throw Object.assign(new Error('campanhas exigem SUPABASE runtime configurado'), { code: 'campaign_persistence_unavailable' });
    const cleanRecipients = [];
    for (const item of Array.isArray(recipients) ? recipients : []) {
      const phone = normalizePhone(String(item?.phone || '').replace(/@.*$/, '').replace(/\D/g, ''));
      if (!phone || phone.length < 8 || phone.length > 15) continue;
      cleanRecipients.push({ id: asId(), phone, name: String(item?.name || 'Cliente').trim().slice(0, 160) || 'Cliente' });
    }
    if (!String(title || '').trim() || !String(message || '').trim() || !cleanRecipients.length || cleanRecipients.length > MAX_RECIPIENTS) {
      throw Object.assign(new Error('payload de campanha inválido'), { code: 'invalid_campaign' });
    }
    const campaignId = asId();
    const created = this.now();
    const campaign = {
      id: campaignId, title: String(title).trim().slice(0, 200), message: String(message).trim().slice(0, 4000),
      status: 'pending', min_delay_seconds: Math.max(MIN_DELAY_SECONDS, Number(minDelay) || 6),
      max_delay_seconds: Math.max(Math.max(MIN_DELAY_SECONDS, Number(minDelay) || 6), Number(maxDelay) || 15),
      total_recipients: cleanRecipients.length, created_by: actorId, created_at: created, updated_at: created
    };
    const idem = String(idempotencyKey || '').trim();
    if (idem) {
      const existing = await this.client.select('idempotency_keys', `select=resource_id,status_code,response_body&scope=eq.campaign_create&key=eq.${encodeURIComponent(idem)}&limit=1`);
      if (existing?.[0]?.resource_id) return this.get(existing[0].resource_id);
    }
    await this.client.insert('campaigns', campaign);
    await this.client.insert('campaign_recipients', cleanRecipients.map(item => ({ ...item, campaign_id: campaignId, status: 'pending' })));
    if (idem) await this.client.insert('idempotency_keys', { scope: 'campaign_create', key: idem, resource_id: campaignId, status_code: 201, response_body: { id: campaignId } });
    return this.get(campaignId);
  }
  async get(id) {
    if (!this.enabled) throw Object.assign(new Error('campanhas exigem SUPABASE runtime configurado'), { code: 'campaign_persistence_unavailable' });
    const rows = await this.client.select('campaigns', `select=id,title,message,status,min_delay_seconds,max_delay_seconds,total_recipients,created_at,started_at,completed_at,updated_at& id=eq.${encodeURIComponent(id)}&limit=1`.replace('& id=', '&id='));
    const row = rows?.[0];
    if (!row) return null;
    const recipients = await this.client.select('campaign_recipients', `select=id,phone,name,status,error,sent_at&campaign_id=eq.${encodeURIComponent(id)}&order=created_at.asc&limit=${MAX_RECIPIENTS}`);
    return { ...row, recipients: (recipients || []).map(publicRecipient), sentCount: (recipients || []).filter(r => statusFor(r) === 'sent').length, failedCount: (recipients || []).filter(r => statusFor(r) === 'failed').length, suppressedCount: (recipients || []).filter(r => statusFor(r) === 'suppressed').length };
  }
  async list() {
    if (!this.enabled) throw Object.assign(new Error('campanhas exigem SUPABASE runtime configurado'), { code: 'campaign_persistence_unavailable' });
    const rows = await this.client.select('campaigns', 'select=id,title,message,status,min_delay_seconds,max_delay_seconds,total_recipients,created_at,started_at,completed_at,updated_at&order=created_at.desc&limit=100');
    return Promise.all((rows || []).map(row => this.get(row.id)));
  }
  async transition(id, status) {
    if (!['paused', 'cancelled'].includes(status)) throw Object.assign(new Error('transição inválida'), { code: 'invalid_campaign_transition' });
    const current = await this.get(id);
    if (!current) return null;
    if (['completed', 'cancelled'].includes(statusFor(current))) return current;
    await this.client.request('campaigns', { method: 'PATCH', query: `id=eq.${encodeURIComponent(id)}&status=in.(pending,running,paused)`, body: { status, updated_at: this.now() }, prefer: 'return=minimal' });
    return this.get(id);
  }
  async isSuppressed(phone) {
    if (!this.enabled) return false;
    const rows = await this.client.select('phone_suppressions', `select=phone,reason&phone=eq.${encodeURIComponent(phone)}&limit=1`);
    return rows?.[0] || null;
  }
  async execute(id) {
    if (!this.enabled || typeof this.sender !== 'function') throw Object.assign(new Error('worker de campanhas indisponível'), { code: 'campaign_worker_unavailable' });
    const campaign = await this.get(id);
    if (!campaign) return null;
    if (['cancelled', 'completed'].includes(statusFor(campaign))) return campaign;
    await this.client.request('campaigns', { method: 'PATCH', query: `id=eq.${encodeURIComponent(id)}&status=in.(pending,paused)`, body: { status: 'running', started_at: campaign.started_at || this.now(), updated_at: this.now() }, prefer: 'return=minimal' });
    const pending = campaign.recipients.filter(r => statusFor(r) === 'pending').slice(0, this.maxPerRun);
    for (const recipient of pending) {
      const current = await this.get(id);
      if (!current || ['paused', 'cancelled'].includes(statusFor(current))) break;
      const suppression = await this.isSuppressed(recipient.phone);
      if (suppression) {
        await this.client.request('campaign_recipients', { method: 'PATCH', query: `id=eq.${encodeURIComponent(recipient.id)}&status=eq.pending`, body: { status: 'suppressed', error: `opt_out:${String(suppression.reason || 'requested').slice(0, 480)}`, updated_at: this.now() }, prefer: 'return=minimal' });
        continue;
      }
      const text = campaign.message.replace(/\{\{\s*(nome|name)\s*\}\}/gi, recipient.name).replace(/\{\{\s*(telefone|phone)\s*\}\}/gi, recipient.phone);
      try {
        await this.sender(recipient.phone, text);
        await this.client.request('campaign_recipients', { method: 'PATCH', query: `id=eq.${encodeURIComponent(recipient.id)}&status=eq.pending`, body: { status: 'sent', sent_at: this.now(), updated_at: this.now() }, prefer: 'return=minimal' });
      } catch (error) {
        await this.client.request('campaign_recipients', { method: 'PATCH', query: `id=eq.${encodeURIComponent(recipient.id)}&status=eq.pending`, body: { status: 'failed', error: String(error?.code || error?.message || 'provider_failed').slice(0, 500), updated_at: this.now() }, prefer: 'return=minimal' });
      }
    }
    const latest = await this.get(id);
    if (latest && latest.recipients.every(r => ['sent', 'failed', 'suppressed'].includes(statusFor(r))) && !['cancelled', 'paused'].includes(statusFor(latest))) {
      await this.client.request('campaigns', { method: 'PATCH', query: `id=eq.${encodeURIComponent(id)}`, body: { status: 'completed', completed_at: this.now(), updated_at: this.now() }, prefer: 'return=minimal' });
    } else if (latest && statusFor(latest) === 'running') {
      await this.client.request('campaigns', { method: 'PATCH', query: `id=eq.${encodeURIComponent(id)}`, body: { status: 'pending', updated_at: this.now() }, prefer: 'return=minimal' });
    }
    return this.get(id);
  }
}

export const CAMPAIGN_MAX_RECIPIENTS = MAX_RECIPIENTS;
