import { afterEach, describe, expect, it, vi } from 'vitest';
import { signState, verifyState } from './oauth-state.ts';

const SECRET = 'a'.repeat(32);

afterEach(() => {
  vi.useRealTimers();
});

describe('signState / verifyState', () => {
  it('round-trips orgId and nonce', () => {
    const token = signState(SECRET, 'org-a', 'nonce-1');
    const payload = verifyState(SECRET, token);
    expect(payload).toMatchObject({ orgId: 'org-a', nonce: 'nonce-1' });
    expect(typeof payload?.iat).toBe('number');
  });

  it('rejects a tampered payload', () => {
    const token = signState(SECRET, 'org-a', 'nonce-1');
    const sig = token.split('.')[1];
    const tamperedPayload = Buffer.from(
      JSON.stringify({ orgId: 'org-evil', nonce: 'nonce-1', iat: Date.now() }),
      'utf8',
    ).toString('base64url');
    expect(verifyState(SECRET, `${tamperedPayload}.${sig}`)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = signState(SECRET, 'org-a', 'nonce-1');
    const payloadB64 = token.split('.')[0];
    expect(verifyState(SECRET, `${payloadB64}.deadbeef`)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signState(SECRET, 'org-a', 'nonce-1');
    expect(verifyState('b'.repeat(32), token)).toBeNull();
  });

  it('rejects a malformed token with no separator', () => {
    expect(verifyState(SECRET, 'not-a-valid-token-with-no-dot')).toBeNull();
  });

  it('rejects an expired token (older than 10 minutes)', () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-05T12:00:00.000Z');
    vi.setSystemTime(now);
    const token = signState(SECRET, 'org-a', 'nonce-1');

    vi.setSystemTime(new Date(now.getTime() + 10 * 60 * 1000 + 1000));
    expect(verifyState(SECRET, token)).toBeNull();
  });

  it('accepts a token just under the 10 minute window', () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-05T12:00:00.000Z');
    vi.setSystemTime(now);
    const token = signState(SECRET, 'org-a', 'nonce-1');

    vi.setSystemTime(new Date(now.getTime() + 9 * 60 * 1000));
    expect(verifyState(SECRET, token)).not.toBeNull();
  });

  it('lets a caller reject a token whose orgId does not match the current user', () => {
    const token = signState(SECRET, 'org-a', 'nonce-1');
    const payload = verifyState(SECRET, token);
    expect(payload?.orgId).not.toBe('org-b');
  });
});
