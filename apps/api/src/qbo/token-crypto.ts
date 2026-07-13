// Pure AES-256-GCM encrypt/decrypt for at-rest protection of QBO OAuth tokens
// (see connection-service.ts). No `config` import — kept independently testable with
// arbitrary keys, same style as money.ts/ordering.ts.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const KDF_SALT = 'invoicing-platform:qbo-token-encryption:v1';

let cachedKey: { secret: string; key: Buffer } | null = null;

// scrypt is deliberately slow; memoize per-secret so repeated calls within a process (every
// connection-service read/write) don't redo the KDF on every request.
export function deriveKey(secret: string): Buffer {
  if (cachedKey && cachedKey.secret === secret) {
    return cachedKey.key;
  }
  const key = scryptSync(secret, KDF_SALT, KEY_LENGTH);
  cachedKey = { secret, key };
  return key;
}

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    '.',
  );
}

export function decryptToken(payload: string, key: Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed token ciphertext: expected "iv.authTag.ciphertext"');
  }
  const [ivPart, authTagPart, ciphertextPart] = parts;
  const iv = Buffer.from(ivPart as string, 'base64');
  const authTag = Buffer.from(authTagPart as string, 'base64');
  const ciphertext = Buffer.from(ciphertextPart as string, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
