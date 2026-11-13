import crypto from 'node:crypto';
import { normalizePhone } from './sessions.mjs';

const MAX_RECIPIENTS = 5000;
const MIN_DELAY_SECONDS = 3;
const MAX_DELAY_SECONDS = 86400;
const DEFAULT_RATE_LIMIT = 10;
const nowIso = () => new Date().toISOString();
const asId = () => crypto.randomUUID();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const statusFor = row => String(row?.status || '').toLowerCase();
const safeErrorCode = error => String(error?.code || (error?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_failed')).toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 80);
const validPhone = phone => /^\d{8,15}$/.test(String(phone || ''));
const SUPPRESSION_REASONS = new Set(['Solicitação de opt-out', 'Pedido via atendimento', 'Solicitação administrativa']);
const publicRecipient = row => ({
  id: row.id,
  phone: row.phone,
  name: row.name || 'Cliente',
  status: String(row.status || 'pending').toUpperCase(),
  error: row.error || undefined,
  attempts: Number(row.attempt_count || 0),
  sentAt: row.sent_at || undefined
});

export class CampaignStore {
  constructor({ client, sender, logger = console, now = nowIso, random = Math.random, delay = sleep, maxPerRun = DEFAULT_RATE_LIMIT } = {}) {
    this.client = client;
    this.sender = sender;
    this.logger = logger;
    this.now = now;
    this.random = random;
    this.delay = delay;
    this.maxPerRun = Math.max(1, Number(maxPerRun) || DEFAULT_RATE_LIMIT);
  }
  get enabled() { return Boolean(this.client?.enabled); }
  async create({ title, message, recipients, minDelay = 6, maxDelay = 15, actorId = null, idempotencyKey }) {
    if (!this.enabled) throw Object.assign(new Error('campanhas exigem SUPABASE runtime configurado'), { code: 'campaign_persistence_unavailable' });
    const cleanRecipients = [];
    for (const item of Array.isArray(recipients) ? recipients : []) {
      const phone = normalizePhone(String(item?.phone || '').replace(/@.*$/, '').replace(/\D/g, ''));
      if (!validPhone(phone) || cleanRecipients.some(existing => existing.phone === phone)) continue;
      cleanRecipients.push({ id: asId(), phone, name: String(item?.name || 'Cliente').trim().slice(0, 160) || 'Cliente' });
    }
    if (!String(title || '').trim() || !String(message || '').trim() || !cleanRecipients.length || cleanRecipients.length > MAX_RECIPIENTS) {
      throw Object.assign(new Error('payload de campanha inválido'), { code: 'invalid_campaign' });
    }
    const campaignId = asId();
    const created = this.now();
    const minDelaySeconds = Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Number(minDelay) || 6));
    const maxDelaySeconds = Math.min(MAX_DELAY_SECONDS, Math.max(minDelaySeconds, Number(maxDelay) || 15));
    const campaign = {
      id: campaignId, title: String(title).trim().slice(0, 200), message: String(message).trim().slice(0, 4000),
      status: 'pending', min_delay_seconds: minDelaySeconds, max_delay_seconds: maxDelaySeconds,
      total_recipients: cleanRecipients.length, created_by: actorId, created_at: created, updated_at: created
    };
    const idem = String(idempotencyKey || '').trim();
    if (idem.length > 200) throw Object.assign(new Error('chave de idempotência inválida'), { code: 'invalid_campaign' });
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
    const rows = await this.client.select('campaigns', `select=id,title,message,status,min_delay_seconds,max_delay_seconds,total_recipients,created_by,created_at,started_at,completed_at,updated_at&id=eq.${encodeURIComponent(id)}&limit=1`);
    const row = rows?.[0];
    if (!row) return null;
    const recipients = await this.client.select('campaign_recipients', `select=id,phone,name,status,error,sent_at,attempt_count,updated_at&campaign_id=eq.${encodeURIComponent(id)}&order=created_at.asc&limit=${MAX_RECIPIENTS}`);
    return { ...row, recipients: (recipients || []).map(publicRecipient), sentCount: (recipients || []).filter(r => statusFor(r) === 'sent').length, failedCount: (recipients || []).filter(r => statusFor(r) === 'failed').length, suppressedCount: (recipients || []).filter(r => statusFor(r) === 'suppressed').length, pendingCount: (recipients || []).filter(r => ['pending', 'sending'].includes(statusFor(r))).length };
  }
  async list() {
    if (!this.enabled) throw Object.assign(new Error('campanhas exigem SUPABASE runtime configurado'), { code: 'campaign_persistence_unavailable' });
    const rows = await this.client.select('campaigns', 'select=id,title,message,status,min_delay_seconds,max_delay_seconds,total_recipients,created_at,started_at,completed_at,updated_at&order=created_at.desc&limit=100');
    return Promise.all((rows || []).map(row => this.get(row.id)));
  }
  async listSummaries() {
    if (!this.enabled) throw Object.assign(new Error('campanhas exigem SUPABASE runtime configurado'), { code: 'campaign_persistence_unavailable' });
    const campaigns = await this.client.select('campaigns', 'select=id,title,status,total_recipients,created_at,started_at,completed_at,updated_at&order=created_at.desc&limit=100');
    if (!campaigns?.length) return [];
    const ids = campaigns.map(row => row.id).filter(id => /^[0-9a-f-]{36}$/i.test(String(id || '')));
    const recipients = ids.length ? await this.client.select('campaign_recipients', `select=campaign_id,status&campaign_id=in.(${ids.join(',')})&limit=20000`) : [];
    const counts = new Map();
    for (const recipient of recipients || []) {
      const item = counts.get(recipient.campaign_id) || { sent: 0, failed: 0, suppressed: 0, pending: 0 };
      const status = statusFor(recipient);
      if (status === 'sent') item.sent++;
      else if (status === 'failed') item.failed++;
      else if (status === 'suppressed') item.suppressed++;
      else item.pending++;
      counts.set(recipient.campaign_id, item);
    }
    return campaigns.map(row => ({ ...row, recipientStats: counts.get(row.id) || { sent: 0, failed: 0, suppressed: 0, pending: 0 }, recipientStatsTruncated: (recipients || []).length === 20000 }));
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
    if (!this.enabled) throw Object.assign(new Error('suppression_check_unavailable'), { code: 'suppression_check_unavailable' });
    const normalized = normalizePhone(String(phone || '').replace(/@.*$/, '').replace(/\D/g, ''));
    if (!validPhone(normalized)) throw Object.assign(new Error('invalid_suppression_target'), { code: 'invalid_suppression_target' });
    const rows = await this.client.select('phone_suppressions', `select=phone,reason,source,suppressed_at&phone=eq.${encodeURIComponent(normalized)}&limit=1`);
    return rows?.[0] || null;
  }

  async listSuppressions(limit = 100) {
    if (!this.enabled) throw Object.assign(new Error('campaign_persistence_unavailable'), { code: 'campaign_persistence_unavailable' });
    return this.client.select('phone_suppressions', `select=phone,reason,source,suppressed_at,created_at,updated_at&order=suppressed_at.desc&limit=${Math.min(200, Math.max(1, Number(limit) || 100))}`);
  }

  async addSuppression({ phone, reason = 'Solicitação de opt-out', source = 'dashboard' } = {}) {
    if (!this.enabled) throw Object.assign(new Error('campaign_persistence_unavailable'), { code: 'campaign_persistence_unavailable' });
    const normalized = normalizePhone(String(phone || '').replace(/@.*$/, '').replace(/\D/g, ''));
    const cleanReason = String(reason || 'Solicitação de opt-out').trim();
    if (!validPhone(normalized)) throw Object.assign(new Error('invalid_suppression'), { code: 'invalid_suppression' });
    if (!SUPPRESSION_REASONS.has(cleanReason)) throw Object.assign(new Error('invalid_suppression_reason'), { code: 'invalid_suppression_reason' });
    const row = { phone: normalized, reason: cleanReason, source: String(source || 'dashboard').trim().slice(0, 120) || 'dashboard', suppressed_at: this.now(), updated_at: this.now() };
    const result = await this.client.upsert('phone_suppressions', [row], 'phone');
    return Array.isArray(result) ? result[0] : row;
  }

  async removeSuppression(phone) {
    if (!this.enabled) throw Object.assign(new Error('campaign_persistence_unavailable'), { code: 'campaign_persistence_unavailable' });
    const normalized = normalizePhone(String(phone || '').replace(/@.*$/, '').replace(/\D/g, ''));
    if (!validPhone(normalized)) throw Object.assign(new Error('invalid_suppression'), { code: 'invalid_suppression' });
    await this.client.request('phone_suppressions', { method: 'DELETE', query: `phone=eq.${encodeURIComponent(normalized)}&limit=1`, prefer: 'return=minimal' });
    return { removed: true };
  }

  async patchRecipient(id, fromStatus, body) {
    const result = await this.client.request('campaign_recipients', { method: 'PATCH', query: `id=eq.${encodeURIComponent(id)}&status=eq.${fromStatus}`, body: { ...body, updated_at: this.now() }, prefer: 'return=representation' });
    return Array.isArray(result) && result.length > 0;
  }
  async execute(id) {
    if (!this.enabled || typeof this.sender !== 'function') throw Object.assign(new Error('worker de campanhas indisponível'), { code: 'campaign_worker_unavailable' });
    let campaign = await this.get(id);
    if (!campaign) return null;
    if (['cancelled', 'completed'].includes(statusFor(campaign))) return campaign;
    const staleBefore = new Date(Date.now() - 120000).toISOString();
    if (statusFor(campaign) === 'running') {
      if (new Date(campaign.updated_at || 0).getTime() > Date.now() - 120000) return campaign;
      await this.client.request('campaign_recipients', { method: 'PATCH', query: `campaign_id=eq.${encodeURIComponent(id)}&status=eq.sending&updated_at=lt.${encodeURIComponent(staleBefore)}`, body: { status: 'failed', error: 'worker_interrupted', updated_at: this.now() }, prefer: 'return=minimal' });
      await this.client.request('campaigns', { method: 'PATCH', query: `id=eq.${encodeURIComponent(id)}&status=eq.running&updated_at=lt.${encodeURIComponent(staleBefore)}`, body: { status: 'pending', updated_at: this.now() }, prefer: 'return=minimal' });
      campaign = await this.get(id);
    }
    const claimed = await this.client.request('campaigns', { method: 'PATCH', query: `id=eq.${encodeURIComponent(id)}&status=in.(pending,paused)`, body: { status: 'running', started_at: campaign.started_at || this.now(), updated_at: this.now() }, prefer: 'return=representation' });
    if (!Array.isArray(claimed) || !claimed.length) return this.get(id);
    const pending = campaign.recipients.filter(r => statusFor(r) === 'pending').slice(0, this.maxPerRun);
    let attempted = 0;
    for (const recipient of pending) {
      const current = await this.client.select('campaigns', `select=status&id=eq.${encodeURIComponent(id)}&limit=1`);
      if (!current?.[0] || ['paused', 'cancelled'].includes(statusFor(current[0]))) break;
      const attemptCount = Number(recipient.attempts || 0) + 1;
      if (!await this.patchRecipient(recipient.id, 'pending', { status: 'sending', attempt_count: attemptCount, error: null })) continue;
      const suppression = await this.isSuppressed(recipient.phone);
      if (suppression) {
        await this.patchRecipient(recipient.id, 'sending', { status: 'suppressed', error: 'opt_out', attempt_count: attemptCount });
        continue;
      }
      if (attempted > 0) {
        const minSeconds = Math.max(MIN_DELAY_SECONDS, Number(campaign.min_delay_seconds) || 6);
        const maxSeconds = Math.max(minSeconds, Number(campaign.max_delay_seconds) || minSeconds);
        await this.delay((minSeconds + this.random() * (maxSeconds - minSeconds)) * 1000);
      }
      attempted++;
      const text = campaign.message.replace(/\{\{\s*(nome|name)\s*\}\}/gi, recipient.name).replace(/\{\{\s*(telefone|phone)\s*\}\}/gi, recipient.phone);
      try {
        await this.sender(recipient.phone, text);
        await this.patchRecipient(recipient.id, 'sending', { status: 'sent', sent_at: this.now(), error: null, attempt_count: attemptCount });
      } catch (error) {
        await this.patchRecipient(recipient.id, 'sending', { status: 'failed', error: safeErrorCode(error), attempt_count: attemptCount });
      }
    }
    const latest = await this.get(id);
    if (latest && latest.recipients.every(r => ['sent', 'failed', 'suppressed'].includes(statusFor(r))) && !['cancelled', 'paused'].includes(statusFor(latest))) {
      await this.client.request('campaigns', { method: 'PATCH', query: `id=eq.${encodeURIComponent(id)}&status=eq.running`, body: { status: 'completed', completed_at: this.now(), updated_at: this.now() }, prefer: 'return=minimal' });
    } else if (latest && statusFor(latest) === 'running') {
      await this.client.request('campaigns', { method: 'PATCH', query: `id=eq.${encodeURIComponent(id)}&status=eq.running`, body: { status: 'pending', updated_at: this.now() }, prefer: 'return=minimal' });
    }
    return this.get(id);
  }
}

export const CAMPAIGN_MAX_RECIPIENTS = MAX_RECIPIENTS;
