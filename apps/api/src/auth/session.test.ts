import { describe, expect, it } from 'vitest';
import { generateToken, sha256Hex } from './session.ts';

describe('generateToken', () => {
  it('generates a base64url token with no padding/unsafe chars', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(32);
  });

  it('generates unique tokens', () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe('sha256Hex', () => {
  it('is deterministic for the same input', () => {
    const token = generateToken();
    expect(sha256Hex(token)).toBe(sha256Hex(token));
  });

  it('produces a 64-char lowercase hex digest', () => {
    const hash = sha256Hex('some-token');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});
