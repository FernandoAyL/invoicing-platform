import { describe, expect, it } from 'vitest';
import { decryptToken, deriveKey, encryptToken } from './token-crypto.ts';

const KEY = deriveKey('test-secret-for-token-crypto-tests');

describe('encryptToken / decryptToken', () => {
  it('round-trips the exact original plaintext', () => {
    const plaintext = 'a-real-looking-qbo-access-token-value';
    const ciphertext = encryptToken(plaintext, KEY);
    expect(decryptToken(ciphertext, KEY)).toBe(plaintext);
  });

  it('round-trips an empty string', () => {
    const ciphertext = encryptToken('', KEY);
    expect(decryptToken(ciphertext, KEY)).toBe('');
  });

  it('produces different ciphertext for the same plaintext on each call (random IV)', () => {
    const a = encryptToken('same-token', KEY);
    const b = encryptToken('same-token', KEY);
    expect(a).not.toBe(b);
    expect(decryptToken(a, KEY)).toBe('same-token');
    expect(decryptToken(b, KEY)).toBe('same-token');
  });

  it('throws when the ciphertext segment is tampered with', () => {
    const ciphertext = encryptToken('token-value', KEY);
    const [iv, authTag, body] = ciphertext.split('.');
    const tamperedBody = Buffer.from(body as string, 'base64');
    tamperedBody[0] = (tamperedBody[0] ?? 0) ^ 0xff;
    const tampered = [iv, authTag, tamperedBody.toString('base64')].join('.');
    expect(() => decryptToken(tampered, KEY)).toThrow();
  });

  it('throws when the auth tag segment is tampered with', () => {
    const ciphertext = encryptToken('token-value', KEY);
    const [iv, authTag, body] = ciphertext.split('.');
    const tamperedTag = Buffer.from(authTag as string, 'base64');
    tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 0xff;
    const tampered = [iv, tamperedTag.toString('base64'), body].join('.');
    expect(() => decryptToken(tampered, KEY)).toThrow();
  });

  it('throws on a wrong key', () => {
    const ciphertext = encryptToken('token-value', KEY);
    const wrongKey = deriveKey('a-completely-different-secret');
    expect(() => decryptToken(ciphertext, wrongKey)).toThrow();
  });

  it('throws on a malformed payload shape (wrong segment count)', () => {
    expect(() => decryptToken('not-the-right-shape', KEY)).toThrow(/malformed/);
    expect(() => decryptToken('only.two', KEY)).toThrow(/malformed/);
    expect(() => decryptToken('way.too.many.segments.here', KEY)).toThrow(/malformed/);
  });

  it('throws on a pre-migration plaintext value (no dots at all)', () => {
    expect(() => decryptToken('plain-legacy-access-token', KEY)).toThrow(/malformed/);
  });
});

describe('deriveKey', () => {
  it('is deterministic for the same secret', () => {
    const a = deriveKey('some-secret-value');
    const b = deriveKey('some-secret-value');
    expect(a.equals(b)).toBe(true);
  });

  it('produces a 32-byte key', () => {
    expect(deriveKey('any-secret').length).toBe(32);
  });

  it('produces different keys for different secrets', () => {
    const a = deriveKey('secret-one');
    const b = deriveKey('secret-two');
    expect(a.equals(b)).toBe(false);
  });
});
