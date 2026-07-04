import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import * as schema from '../db/schema.ts';

interface FakeUserRow {
  id: string;
  orgId: string;
  email: string;
  passwordHash: string;
  role: 'admin' | 'member';
}

interface FakeSessionRow {
  userId: string;
  orgId: string;
  tokenHash: string;
  expiresAt: Date;
}

function fakePool(): pg.Pool {
  return {
    query: async () => ({ rows: [] }),
    end: async () => {},
  } as unknown as pg.Pool;
}

/**
 * Minimal stand-in for the drizzle db, supporting only the exact chain shapes
 * the auth routes/session helpers call. Table identity (not the `where`
 * condition, which is an opaque drizzle SQL fragment) decides which in-memory
 * collection is read/written — good enough since each test keeps at most one
 * relevant user/session in play.
 */
function createFakeDb() {
  const state = {
    users: [] as FakeUserRow[],
    sessions: [] as FakeSessionRow[],
  };

  const db = {
    select() {
      return {
        from(table: unknown) {
          if (table === schema.sessions) {
            return {
              innerJoin() {
                return {
                  where() {
                    return {
                      async limit() {
                        return state.sessions.flatMap((s) => {
                          const user = state.users.find((u) => u.id === s.userId);
                          return user
                            ? [
                                {
                                  expiresAt: s.expiresAt,
                                  id: user.id,
                                  orgId: user.orgId,
                                  email: user.email,
                                  role: user.role,
                                },
                              ]
                            : [];
                        });
                      },
                    };
                  },
                };
              },
            };
          }
          if (table === schema.users) {
            return {
              where() {
                return {
                  async limit() {
                    return state.users;
                  },
                };
              },
            };
          }
          throw new Error('fakeDb: unsupported select().from() table');
        },
      };
    },
    insert(table: unknown) {
      return {
        async values(vals: Record<string, unknown>) {
          if (table === schema.sessions) {
            state.sessions.push(vals as unknown as FakeSessionRow);
          }
          return undefined;
        },
      };
    },
    delete(table: unknown) {
      return {
        async where() {
          if (table === schema.sessions) {
            state.sessions = [];
          }
          return undefined;
        },
      };
    },
  };

  return { db: db as unknown as NodePgDatabase<typeof schema>, state };
}

const ADMIN: FakeUserRow = {
  id: 'user-admin',
  orgId: 'org-1',
  email: 'admin@invoicing.test',
  passwordHash: '',
  role: 'admin',
};

const MEMBER: FakeUserRow = {
  id: 'user-member',
  orgId: 'org-1',
  email: 'member@invoicing.test',
  passwordHash: '',
  role: 'member',
};

function buildTestApp(users: FakeUserRow[] = []) {
  const { db, state } = createFakeDb();
  state.users = users;
  const app = buildApp({ pool: fakePool(), db });
  return { app, state };
}

function sidCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === 'sid')?.value;
}

describe('POST /api/auth/login', () => {
  it('returns 200 + sets an httpOnly session cookie on success', async () => {
    const password = 'correct horse battery staple';
    const { app } = buildTestApp([{ ...ADMIN, passwordHash: await hashPassword(password) }]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: ADMIN.id, email: ADMIN.email, role: 'admin' });

    const cookie = res.cookies.find((c) => c.name === 'sid');
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');

    await app.close();
  });

  it('returns 401 invalid_credentials on a wrong password, no cookie set', async () => {
    const { app } = buildTestApp([
      { ...ADMIN, passwordHash: await hashPassword('the-real-password') },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password: 'wrong-password' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect(sidCookie(res)).toBeUndefined();

    await app.close();
  });

  it('returns 401 invalid_credentials for an unknown email (same shape as wrong password)', async () => {
    const { app } = buildTestApp([]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@invoicing.test', password: 'whatever' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });

    await app.close();
  });

  it('returns 400 on a malformed body', async () => {
    const { app } = buildTestApp([]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'not-an-email', password: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a session cookie', async () => {
    const { app } = buildTestApp([]);
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 200 with the current user when authenticated', async () => {
    const password = 'correct horse battery staple';
    const { app } = buildTestApp([{ ...ADMIN, passwordHash: await hashPassword(password) }]);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password },
    });
    const sid = sidCookie(login);
    expect(sid).toBeDefined();

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { sid: sid as string },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: ADMIN.id, email: ADMIN.email, role: 'admin' });

    await app.close();
  });
});

describe('POST /api/auth/logout', () => {
  it('is idempotent (204) with no cookie', async () => {
    const { app } = buildTestApp([]);
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('clears the cookie and revokes the session server-side', async () => {
    const password = 'correct horse battery staple';
    const { app } = buildTestApp([{ ...ADMIN, passwordHash: await hashPassword(password) }]);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password },
    });
    const sid = sidCookie(login) as string;

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { sid },
    });
    expect(logout.statusCode).toBe(204);

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { sid },
    });
    expect(me.statusCode).toBe(401);

    await app.close();
  });
});

describe('requireRole', () => {
  it('returns 403 for a member hitting an admin-only route', async () => {
    const password = 'member-password';
    const { app } = buildTestApp([{ ...MEMBER, passwordHash: await hashPassword(password) }]);
    app.register(async (instance) => {
      instance.get('/test/admin-only', { preHandler: instance.requireRole('admin') }, async () => ({
        ok: true,
      }));
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: MEMBER.email, password },
    });
    const sid = sidCookie(login) as string;

    const res = await app.inject({ method: 'GET', url: '/test/admin-only', cookies: { sid } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });

    await app.close();
  });

  it('allows an admin through', async () => {
    const password = 'admin-password';
    const { app } = buildTestApp([{ ...ADMIN, passwordHash: await hashPassword(password) }]);
    app.register(async (instance) => {
      instance.get('/test/admin-only', { preHandler: instance.requireRole('admin') }, async () => ({
        ok: true,
      }));
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password },
    });
    const sid = sidCookie(login) as string;

    const res = await app.inject({ method: 'GET', url: '/test/admin-only', cookies: { sid } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await app.close();
  });
});
