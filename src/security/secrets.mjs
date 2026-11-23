import crypto from 'node:crypto';

const PREFIX = 'lia-secret:v1:';

function resolveKey(explicitKey) {
  const rawValue = explicitKey === undefined ? process.env.API_SECRETS_ENCRYPTION_KEY : explicitKey;
  if (Buffer.isBuffer(rawValue)) {
    if (rawValue.length !== 32) throw new Error('invalid_api_secrets_encryption_key');
    return rawValue;
  }
  const raw = String(rawValue || '').trim();
  if (!raw) return null;
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('invalid_api_secrets_encryption_key');
  return key;
}

export function hasSecretEncryptionKey(explicitKey) {
  try { return Boolean(resolveKey(explicitKey)); } catch { return false; }
}

export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(value, { key, context = '' } = {}) {
  const plain = String(value ?? '');
  if (!plain || isEncryptedSecret(plain)) return plain;
  const encryptionKey = resolveKey(key);
  if (!encryptionKey) throw new Error('api_secret_encryption_key_missing');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(Buffer.from(String(context), 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptSecret(value, { key, context = '' } = {}) {
  const stored = String(value ?? '');
  if (!isEncryptedSecret(stored)) return stored;
  const encryptionKey = resolveKey(key);
  if (!encryptionKey) throw new Error('api_secret_encryption_key_missing');
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('invalid_encrypted_api_secret');
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const ciphertext = Buffer.from(parts[2], 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid_encrypted_api_secret');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAAD(Buffer.from(String(context), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('api_secret_decryption_failed');
  }
}
