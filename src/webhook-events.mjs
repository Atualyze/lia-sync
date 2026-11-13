import crypto from 'node:crypto';

const safeCode = value => String(value || 'processing_failed').toLowerCase().replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'email').replace(/\d{8,15}/g, 'number').replace(/[^a-z0-9_-]/g, '_').slice(0, 80);
const safeLabel = (value, fallback = 'unknown', max = 120) => String(value || fallback).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'email').replace(/\d{8,15}/g, '_').replace(/[^a-z0-9_.-]/gi, '_').slice(0, max) || fallback;

export class WebhookEventStore {
  constructor({ client, now = () => new Date().toISOString() } = {}) {
    this.client = client;
    this.now = now;
  }

  get enabled() { return Boolean(this.client?.enabled); }

  hashKey(key) {
    if (key === undefined || key === null || key === '') return null;
    return crypto.createHash('sha256').update(String(key)).digest('hex');
  }

  async begin({ key, eventType = 'unknown', instance = '' } = {}) {
    if (!this.enabled) return { tracked: false, duplicate: false, key: null, attemptCount: 0 };
    const hashedKey = this.hashKey(key);
    if (!hashedKey) return { tracked: false, duplicate: false, key: null, attemptCount: 0 };
    const existing = await this.client.select('webhook_events', `select=event_key,status,attempt_count,updated_at&event_key=eq.${hashedKey}&limit=1`);
    const row = existing?.[0];
    if (row) {
      const stale = Date.now() - new Date(row.updated_at || row.received_at || 0).getTime() > 120000;
      if (['processed', 'ignored'].includes(row.status) || (row.status === 'received' && !stale)) {
        return { tracked: true, duplicate: true, key: hashedKey };
      }
      if (!['failed', 'received'].includes(row.status)) return { tracked: true, duplicate: true, key: hashedKey };
      const expectedStatus = row.status;
      const attemptCount = Number(row.attempt_count || 0) + 1;
      const staleFilter = expectedStatus === 'received' ? `&updated_at=lt.${encodeURIComponent(new Date(Date.now() - 120000).toISOString())}` : '';
      const claimed = await this.client.request('webhook_events', {
        method: 'PATCH',
        query: `event_key=eq.${hashedKey}&status=eq.${expectedStatus}${staleFilter}`,
        body: { status: 'received', attempt_count: attemptCount, error_code: null, updated_at: this.now() },
        prefer: 'return=representation'
      });
      if (!Array.isArray(claimed) || !claimed.length) return { tracked: true, duplicate: true, key: hashedKey };
      return { tracked: true, duplicate: false, key: hashedKey, attemptCount };
    }
    try {
      await this.client.insert('webhook_events', [{
        event_key: hashedKey,
        event_type: safeLabel(eventType, 'unknown'),
        instance_name: safeLabel(instance, '', 80) || null,
        status: 'received',
        attempt_count: 1,
        received_at: this.now(),
        updated_at: this.now()
      }]);
      return { tracked: true, duplicate: false, key: hashedKey, attemptCount: 1 };
    } catch (error) {
      if (/HTTP 409|duplicate key|unique constraint/i.test(error?.message || '')) return { tracked: true, duplicate: true, key: hashedKey };
      throw error;
    }
  }

  async finish(tracking, status, errorCode = null) {
    if (!this.enabled || !tracking?.tracked || !tracking.key) return;
    if (!['processed', 'ignored', 'failed'].includes(status)) return;
    await this.client.request('webhook_events', {
      method: 'PATCH',
      query: `event_key=eq.${tracking.key}&status=eq.received&attempt_count=eq.${Number(tracking.attemptCount || 1)}`,
      body: {
        status,
        error_code: status === 'failed' ? safeCode(errorCode) : null,
        processed_at: status === 'processed' || status === 'ignored' ? this.now() : null,
        updated_at: this.now()
      },
      prefer: 'return=minimal'
    });
  }

  async list(limit = 50) {
    if (!this.enabled) return { configured: false, events: [] };
    const rows = await this.client.select('webhook_events', `select=event_type,instance_name,status,attempt_count,error_code,received_at,processed_at&order=received_at.desc&limit=${Math.min(100, Math.max(1, Number(limit) || 50))}`);
    return { configured: true, events: (rows || []).map(row => ({
      eventType: safeLabel(row.event_type, 'unknown'),
      instance: row.instance_name ? safeLabel(row.instance_name, '', 80) || null : null,
      status: row.status,
      attempts: Number(row.attempt_count || 1),
      errorCode: row.error_code || null,
      receivedAt: row.received_at,
      processedAt: row.processed_at || null
    })) };
  }
}
