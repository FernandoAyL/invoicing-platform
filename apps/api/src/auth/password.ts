import { randomBytes, type ScryptOptions, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Never throws — malformed stored hashes are treated as a verification failure. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = await scrypt(password, salt, expected.length, { N: n, r, p });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
