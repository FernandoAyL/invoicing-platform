import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.ts';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password', stored)).resolves.toBe(false);
  });

  it('produces a distinct hash (and salt) each time', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
  });

  it('stores the expected scrypt$N$r$p$salt$hash format', async () => {
    const stored = await hashPassword('x');
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it('returns false (never throws) for a malformed stored hash', async () => {
    await expect(verifyPassword('x', 'not-a-real-hash')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$16384$8$1$onlyfourfields')).resolves.toBe(false);
    await expect(verifyPassword('x', '')).resolves.toBe(false);
  });
});
