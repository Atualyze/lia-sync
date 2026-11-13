const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class TtlIdempotencyStore {
  constructor({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, max = 2000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.max = max;
    this.entries = new Map();
  }

  purge() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.createdAt <= cutoff) this.entries.delete(key);
    }
  }

  get(key) {
    if (!key) return undefined;
    this.purge();
    return this.entries.get(String(key))?.value;
  }

  set(key, value) {
    if (!key) return value;
    this.purge();
    this.entries.set(String(key), { createdAt: this.now(), value });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
    return value;
  }

  claim(key, value = true) {
    if (!key) return { duplicate: false, value: undefined };
    const existing = this.get(key);
    if (existing !== undefined) return { duplicate: true, value: existing };
    this.set(key, value);
    return { duplicate: false, value };
  }
}

export const idempotencyKey = (...parts) => parts.map(part => String(part ?? '').trim()).join(':');
