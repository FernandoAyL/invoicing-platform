import { randomUUID } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import * as schema from '../db/schema.ts';
import type { QboOAuthClient, QboTokenResult } from '../qbo/oauth-client.ts';
import { signState } from '../qbo/oauth-state.ts';

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

interface FakeConnectionRow {
  id: string;
  orgId: string;
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeAuditRow {
  id: string;
  orgId: string;
  entityType: string | null;
  localId: string | null;
  action: string;
  direction: string;
  outcome: string;
  triggeringEvent: string | null;
  detail: unknown;
  userId: string | null;
  createdAt: Date;
}

function fakePool(): pg.Pool {
  return {
    query: async () => ({ rows: [] }),
    end: async () => {},
  } as unknown as pg.Pool;
}

interface SqlChunk {
  queryChunks?: SqlChunk[];
  constructor: { name: string };
  value?: unknown;
  table?: unknown;
  name?: unknown;
}

function extractEqPairs(
  node: SqlChunk | null | undefined,
  acc: { columns: SqlChunk[]; params: unknown[] } = { columns: [], params: [] },
) {
  if (!node) return acc;
  if (Array.isArray(node.queryChunks)) {
    for (const chunk of node.queryChunks) extractEqPairs(chunk, acc);
    return acc;
  }
  const ctorName = node.constructor?.name;
  if (ctorName === 'Param') {
    acc.params.push(node.value);
  } else if (ctorName !== 'StringChunk' && node.table && typeof node.name === 'string') {
    acc.columns.push(node);
  }
  return acc;
}

const userColumnKeyByRef = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.users)).map(([key, col]) => [col, key]),
);
const connectionColumnKeyByRef = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.qboConnections)).map(([key, col]) => [col, key]),
);

function rowMatchesWith(
  row: Record<string, unknown>,
  cond: unknown,
  columnMap: Map<unknown, string>,
): boolean {
  const { columns, params } = extractEqPairs(cond as SqlChunk);
  if (columns.length === 0) return true;
  return columns.every((col, i) => {
    const key = columnMap.get(col);
    if (!key) throw new Error('fakeDb: unmapped column in where clause');
    return row[key] === params[i];
  });
}

function cloneRow<T>(row: T): T {
  return { ...row };
}

function createFakeDb() {
  const state = {
    users: [] as FakeUserRow[],
    sessions: [] as FakeSessionRow[],
    connections: [] as FakeConnectionRow[],
    auditLogs: [] as FakeAuditRow[],
  };

  const baseDb = {
    select() {
      return {
        from(table: unknown) {
          if (table === schema.qboConnections) {
            return {
              where(cond: unknown) {
                const filtered = state.connections.filter((r) =>
                  rowMatchesWith(
                    r as unknown as Record<string, unknown>,
                    cond,
                    connectionColumnKeyByRef,
                  ),
                );
                const result = Promise.resolve(filtered.map(cloneRow)) as Promise<
                  FakeConnectionRow[]
                > & { limit: (n: number) => Promise<FakeConnectionRow[]> };
                result.limit = (n: number) => Promise.resolve(filtered.slice(0, n).map(cloneRow));
                return result;
              },
            };
          }
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
              where(cond: unknown) {
                return {
                  async limit() {
                    return state.users.filter((r) =>
                      rowMatchesWith(
                        r as unknown as Record<string, unknown>,
                        cond,
                        userColumnKeyByRef,
                      ),
                    );
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
        values(vals: Record<string, unknown>) {
          if (table === schema.sessions) {
            state.sessions.push(vals as unknown as FakeSessionRow);
            return Promise.resolve(undefined);
          }
          if (table === schema.qboConnections) {
            const now = new Date();
            const row: FakeConnectionRow = {
              id: randomUUID(),
              orgId: vals.orgId as string,
              realmId: vals.realmId as string,
              accessToken: vals.accessToken as string,
              refreshToken: vals.refreshToken as string,
              accessTokenExpiresAt: (vals.accessTokenExpiresAt as Date | undefined) ?? null,
              refreshTokenExpiresAt: (vals.refreshTokenExpiresAt as Date | undefined) ?? null,
              createdAt: now,
              updatedAt: (vals.updatedAt as Date | undefined) ?? now,
            };
            state.connections.push(row);
            const result = Promise.resolve([cloneRow(row)]) as Promise<FakeConnectionRow[]> & {
              returning: () => Promise<FakeConnectionRow[]>;
            };
            result.returning = () => Promise.resolve([cloneRow(row)]);
            return result;
          }
          if (table === schema.syncAuditLogs) {
            const row: FakeAuditRow = {
              id: randomUUID(),
              orgId: vals.orgId as string,
              entityType: (vals.entityType as string | undefined) ?? null,
              localId: (vals.localId as string | undefined) ?? null,
              action: vals.action as string,
              direction: vals.direction as string,
              outcome: (vals.outcome as string | undefined) ?? 'success',
              triggeringEvent: (vals.triggeringEvent as string | undefined) ?? null,
              detail: vals.detail ?? null,
              userId: (vals.userId as string | undefined) ?? null,
              createdAt: new Date(),
            };
            state.auditLogs.push(row);
            return Promise.resolve(undefined);
          }
          throw new Error('fakeDb: unsupported insert().values() table');
        },
      };
    },
    update(table: unknown) {
      return {
        set(vals: Record<string, unknown>) {
          return {
            where(cond: unknown) {
              return {
                async returning() {
                  if (table !== schema.qboConnections) {
                    throw new Error('fakeDb: unsupported update() table');
                  }
                  const matched = state.connections.filter((r) =>
                    rowMatchesWith(
                      r as unknown as Record<string, unknown>,
                      cond,
                      connectionColumnKeyByRef,
                    ),
                  );
                  for (const row of matched) Object.assign(row, vals);
                  return matched.map(cloneRow);
                },
              };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where(cond: unknown) {
          return {
            async returning(selection?: Record<string, unknown>) {
              if (table === schema.sessions) {
                state.sessions = [];
                return [];
              }
              if (table !== schema.qboConnections) {
                throw new Error('fakeDb: unsupported delete() table');
              }
              const matched = state.connections.filter((r) =>
                rowMatchesWith(
                  r as unknown as Record<string, unknown>,
                  cond,
                  connectionColumnKeyByRef,
                ),
              );
              state.connections = state.connections.filter(
                (r) =>
                  !rowMatchesWith(
                    r as unknown as Record<string, unknown>,
                    cond,
                    connectionColumnKeyByRef,
                  ),
              );
              return matched.map((row) => {
                if (!selection) return cloneRow(row);
                return Object.fromEntries(
                  Object.keys(selection).map((k) => [
                    k,
                    (row as unknown as Record<string, unknown>)[k],
                  ]),
                );
              });
            },
          };
        },
      };
    },
  };

  const db = {
    ...baseDb,
    async transaction<T>(fn: (tx: typeof baseDb) => Promise<T>): Promise<T> {
      const snapshot = {
        connections: state.connections.map(cloneRow),
        auditLogs: state.auditLogs.map(cloneRow),
      };
      try {
        return await fn(baseDb);
      } catch (err) {
        state.connections = snapshot.connections;
        state.auditLogs = snapshot.auditLogs;
        throw err;
      }
    },
  };

  return { db: db as unknown as NodePgDatabase<typeof schema>, state };
}

const ORG_A = 'org-a';

const ADMIN: FakeUserRow = {
  id: 'user-admin',
  orgId: ORG_A,
  email: 'admin@invoicing.test',
  passwordHash: '',
  role: 'admin',
};

const MEMBER: FakeUserRow = {
  id: 'user-member',
  orgId: ORG_A,
  email: 'member@invoicing.test',
  passwordHash: '',
  role: 'member',
};

const BASE_TOKENS: QboTokenResult = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresIn: 3600,
  refreshTokenExpiresIn: 8726400,
};

function stubClient(overrides: Partial<QboOAuthClient> = {}): QboOAuthClient {
  return {
    authorizeUrl: ({ state }) => `https://appcenter.intuit.com/connect/oauth2?state=${state}`,
    exchangeCode: async () => BASE_TOKENS,
    refresh: async () => BASE_TOKENS,
    revoke: async () => {},
    ...overrides,
  };
}

async function buildTestApp(
  opts: { users?: FakeUserRow[]; qboOAuthClient?: QboOAuthClient | null } = {},
) {
  const users = opts.users ?? [ADMIN, MEMBER];
  const { db, state } = createFakeDb();
  const password = 'correct horse battery staple';
  state.users = await Promise.all(
    users.map(async (u) => ({ ...u, passwordHash: await hashPassword(password) })),
  );
  const app = buildApp({ pool: fakePool(), db, qboOAuthClient: opts.qboOAuthClient });
  return { app, state, password };
}

function sidCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === 'sid')?.value;
}

async function loginAs(app: ReturnType<typeof buildApp>, user: FakeUserRow, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: user.email, password },
  });
  const sid = sidCookie(res);
  if (!sid) throw new Error('login failed in test setup');
  return sid;
}

describe('GET /api/integrations/qbo/connect', () => {
  it('returns 401 without a session cookie', async () => {
    const { app } = await buildTestApp({ qboOAuthClient: stubClient() });
    const res = await app.inject({ method: 'GET', url: '/api/integrations/qbo/connect' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 403 for a member (non-admin)', async () => {
    const { app, password } = await buildTestApp({ qboOAuthClient: stubClient() });
    const sid = await loginAs(app, MEMBER, password);
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/connect',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns 200 with an authorizeUrl for an admin when configured, and audits it', async () => {
    const { app, state, password } = await buildTestApp({ qboOAuthClient: stubClient() });
    const sid = await loginAs(app, ADMIN, password);

    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/connect',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.authorizeUrl).toBe('string');
    expect(body.authorizeUrl).toContain('state=');

    expect(state.auditLogs).toHaveLength(1);
    expect(state.auditLogs[0]).toMatchObject({
      orgId: ORG_A,
      entityType: 'qbo_connection',
      action: 'qbo.connect.initiated',
      direction: 'local',
      outcome: 'success',
      userId: ADMIN.id,
    });
    await app.close();
  });

  it('returns 503 when the QBO client is not configured', async () => {
    const { app, password } = await buildTestApp({ qboOAuthClient: null });
    const sid = await loginAs(app, ADMIN, password);

    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/connect',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'qbo_not_configured' });
    await app.close();
  });
});

describe('GET /api/integrations/qbo/callback', () => {
  it('returns 403 for a member', async () => {
    const { app, password } = await buildTestApp({ qboOAuthClient: stubClient() });
    const sid = await loginAs(app, MEMBER, password);
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/callback?code=abc&state=x&realmId=123',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns 400 for a missing querystring field', async () => {
    const { app, password } = await buildTestApp({ qboOAuthClient: stubClient() });
    const sid = await loginAs(app, ADMIN, password);
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/callback?code=abc&state=x',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('exchanges the code, upserts the connection, and 302-redirects on success', async () => {
    const { app, state, password } = await buildTestApp({ qboOAuthClient: stubClient() });
    const sid = await loginAs(app, ADMIN, password);

    const connectRes = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/connect',
      cookies: { sid },
    });
    const authorizeUrl = new URL(connectRes.json().authorizeUrl);
    const validState = authorizeUrl.searchParams.get('state') as string;

    const res = await app.inject({
      method: 'GET',
      url: `/api/integrations/qbo/callback?code=auth-code&state=${encodeURIComponent(validState)}&realmId=realm-123`,
      cookies: { sid },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/integrations?connected=1');

    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/status',
      cookies: { sid },
    });
    expect(statusRes.json()).toMatchObject({ connected: true, realmId: 'realm-123' });
    expect(JSON.stringify(statusRes.json())).not.toMatch(/access-1|refresh-1/);

    const successAudits = state.auditLogs.filter(
      (a) => a.action === 'qbo.connect.callback' && a.outcome === 'success',
    );
    expect(successAudits).toHaveLength(1);
    await app.close();
  });

  it('returns 400 invalid_state for a tampered/foreign-org state, and does not connect', async () => {
    const { app, state, password } = await buildTestApp({ qboOAuthClient: stubClient() });
    const sid = await loginAs(app, ADMIN, password);

    const foreignState = signState('a'.repeat(32), 'some-other-org', randomUUID());
    const res = await app.inject({
      method: 'GET',
      url: `/api/integrations/qbo/callback?code=auth-code&state=${encodeURIComponent(foreignState)}&realmId=realm-123`,
      cookies: { sid },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_state' });
    expect(state.connections).toHaveLength(0);

    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/status',
      cookies: { sid },
    });
    expect(statusRes.json().connected).toBe(false);
    await app.close();
  });

  it('302-redirects to an error path when the token exchange fails, with no row written', async () => {
    const failingClient = stubClient({
      exchangeCode: async () => {
        throw new Error('invalid_grant');
      },
    });
    const { app, state, password } = await buildTestApp({ qboOAuthClient: failingClient });
    const sid = await loginAs(app, ADMIN, password);

    const connectRes = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/connect',
      cookies: { sid },
    });
    const validState = new URL(connectRes.json().authorizeUrl).searchParams.get('state') as string;

    const res = await app.inject({
      method: 'GET',
      url: `/api/integrations/qbo/callback?code=bad&state=${encodeURIComponent(validState)}&realmId=realm-123`,
      cookies: { sid },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/integrations?error=qbo_connect_failed');
    expect(state.connections).toHaveLength(0);

    const failureAudits = state.auditLogs.filter(
      (a) => a.action === 'qbo.connect.callback' && a.outcome === 'failure',
    );
    expect(failureAudits).toHaveLength(1);
    await app.close();
  });

  it('returns 503 when the QBO client is not configured', async () => {
    const { app, password } = await buildTestApp({ qboOAuthClient: null });
    const sid = await loginAs(app, ADMIN, password);
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/callback?code=abc&state=x&realmId=123',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('GET /api/integrations/qbo/status', () => {
  it('returns 401 without a session, 403 for a member', async () => {
    const { app, password } = await buildTestApp({ qboOAuthClient: stubClient() });
    const anon = await app.inject({ method: 'GET', url: '/api/integrations/qbo/status' });
    expect(anon.statusCode).toBe(401);

    const sid = await loginAs(app, MEMBER, password);
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/status',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns connected:false with no configured client (still 200, not 503)', async () => {
    const { app, password } = await buildTestApp({ qboOAuthClient: null });
    const sid = await loginAs(app, ADMIN, password);
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/status',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      connected: false,
      realmId: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
    await app.close();
  });
});

describe('POST /api/integrations/qbo/disconnect', () => {
  it('returns 403 for a member', async () => {
    const { app, password } = await buildTestApp({ qboOAuthClient: stubClient() });
    const sid = await loginAs(app, MEMBER, password);
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/disconnect',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('calls revoke, deletes the row, audits it, and is idempotent on a second call', async () => {
    const revoke = vi.fn(async () => {});
    const { app, state, password } = await buildTestApp({
      qboOAuthClient: stubClient({ revoke }),
    });
    const sid = await loginAs(app, ADMIN, password);

    const connectRes = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/connect',
      cookies: { sid },
    });
    const validState = new URL(connectRes.json().authorizeUrl).searchParams.get('state') as string;
    await app.inject({
      method: 'GET',
      url: `/api/integrations/qbo/callback?code=auth-code&state=${encodeURIComponent(validState)}&realmId=realm-123`,
      cookies: { sid },
    });
    expect(state.connections).toHaveLength(1);

    const first = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/disconnect',
      cookies: { sid },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ connected: false });
    expect(revoke).toHaveBeenCalledWith('refresh-1');
    expect(state.connections).toHaveLength(0);

    const second = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/disconnect',
      cookies: { sid },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ connected: false });

    const disconnectAudits = state.auditLogs.filter((a) => a.action === 'qbo.disconnect');
    expect(disconnectAudits).toHaveLength(2);
    await app.close();
  });

  it('still disconnects locally when the revoke call throws', async () => {
    const revoke = vi.fn(async () => {
      throw new Error('intuit already dropped it');
    });
    const { app, state, password } = await buildTestApp({
      qboOAuthClient: stubClient({ revoke }),
    });
    const sid = await loginAs(app, ADMIN, password);

    const connectRes = await app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/connect',
      cookies: { sid },
    });
    const validState = new URL(connectRes.json().authorizeUrl).searchParams.get('state') as string;
    await app.inject({
      method: 'GET',
      url: `/api/integrations/qbo/callback?code=auth-code&state=${encodeURIComponent(validState)}&realmId=realm-123`,
      cookies: { sid },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/disconnect',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false });
    expect(state.connections).toHaveLength(0);
    await app.close();
  });

  it('returns 200 connected:false even with no configured client and no connection', async () => {
    const { app, password } = await buildTestApp({ qboOAuthClient: null });
    const sid = await loginAs(app, ADMIN, password);
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/disconnect',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false });
    await app.close();
  });
});
