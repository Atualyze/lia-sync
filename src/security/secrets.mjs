import crypto from 'node:crypto';

// v1: lia-secret:v1:<iv>:<tag>:<ct>            (sem identificador de chave; legado)
// v2: lia-secret:v2:<kid>:<iv>:<tag>:<ct>      (kid = 8 primeiros hex de SHA-256 da chave)
const PREFIX_V1 = 'lia-secret:v1:';
const PREFIX_V2 = 'lia-secret:v2:';

function parseKey(rawValue) {
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

export function keyIdOf(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function entryOf(rawValue) {
  const key = parseKey(rawValue);
  return key ? { key, kid: keyIdOf(key) } : null;
}

// Chaveiro: `current` cifra e decifra; `previous` só decifra (rotação).
// Chaves anteriores vêm de `previousKeys` ou de API_SECRETS_PREVIOUS_KEYS (separadas por vírgula).
function resolveKeyring(explicitKey, previousKeys) {
  const current = entryOf(explicitKey === undefined ? process.env.API_SECRETS_ENCRYPTION_KEY : explicitKey);
  const rawPrevious = previousKeys !== undefined
    ? previousKeys
    : String(process.env.API_SECRETS_PREVIOUS_KEYS || '').split(',');
  const previous = [];
  for (const raw of rawPrevious) {
    const entry = entryOf(raw);
    if (entry && entry.kid !== current?.kid && !previous.some(item => item.kid === entry.kid)) previous.push(entry);
  }
  return { current, previous };
}

export function hasSecretEncryptionKey(explicitKey) {
  try { return Boolean(resolveKeyring(explicitKey).current); } catch { return false; }
}

export function isEncryptedSecret(value) {
  return typeof value === 'string' && (value.startsWith(PREFIX_V1) || value.startsWith(PREFIX_V2));
}

/** kid gravado no valor (v2) ou null (v1/texto claro). Nunca expõe material de chave. */
export function secretKeyId(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX_V2)) return null;
  return value.slice(PREFIX_V2.length).split(':')[0] || null;
}

/** true se o valor é texto claro, está em v1 ou foi cifrado com outra chave que não a atual. */
export function needsReencryption(value, { key, previousKeys } = {}) {
  const stored = String(value ?? '');
  if (!stored) return false;
  const { current } = resolveKeyring(key, previousKeys);
  if (!current) return false;
  if (!isEncryptedSecret(stored)) return true;
  return secretKeyId(stored) !== current.kid;
}

export function encryptSecret(value, { key, context = '' } = {}) {
  const plain = String(value ?? '');
  if (!plain || isEncryptedSecret(plain)) return plain;
  const { current } = resolveKeyring(key);
  if (!current) throw new Error('api_secret_encryption_key_missing');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', current.key, iv);
  cipher.setAAD(Buffer.from(String(context), 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX_V2 + [current.kid, iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function openWith(entry, parts, context) {
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid_encrypted_api_secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', entry.key, iv);
  decipher.setAAD(Buffer.from(String(context), 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function decryptSecret(value, { key, previousKeys, context = '' } = {}) {
  const stored = String(value ?? '');
  if (!isEncryptedSecret(stored)) return stored;
  const { current, previous } = resolveKeyring(key, previousKeys);
  if (!current) throw new Error('api_secret_encryption_key_missing');
  const ring = [current, ...previous];
  const isV2 = stored.startsWith(PREFIX_V2);
  const parts = stored.slice((isV2 ? PREFIX_V2 : PREFIX_V1).length).split(':');
  if (parts.length !== (isV2 ? 4 : 3)) throw new Error('invalid_encrypted_api_secret');
  if (isV2) {
    const kid = parts.shift();
    const entry = ring.find(item => item.kid === kid);
    if (!entry) throw new Error('api_secret_key_unavailable');
    try { return openWith(entry, parts, context); } catch { throw new Error('api_secret_decryption_failed'); }
  }
  // v1 não identifica a chave: tenta a atual e depois as anteriores.
  for (const entry of ring) {
    try { return openWith(entry, parts, context); } catch { /* tenta a próxima */ }
  }
  throw new Error('api_secret_decryption_failed');
}
