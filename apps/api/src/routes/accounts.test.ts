import { randomUUID } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
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

interface FakeAccountRow {
  id: string;
  orgId: string;
  code: string | null;
  name: string;
  type: string;
  subtype: string | null;
  parentId: string | null;
  currency: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function fakePool(): pg.Pool {
  return {
    query: async () => ({ rows: [] }),
    end: async () => {},
  } as unknown as pg.Pool;
}

const accountColumnKeyByRef = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.accounts)).map(([key, col]) => [col, key]),
);
const userColumnKeyByRef = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.users)).map(([key, col]) => [col, key]),
);

interface SqlChunk {
  queryChunks?: SqlChunk[];
  constructor: { name: string };
  value?: unknown;
  table?: unknown;
  name?: unknown;
}

// See routes/contacts.test.ts for the rationale behind this walk: `eq`/`and`
// conditions are opaque SQL fragment trees at runtime, and this service only
// ever builds simple `eq` leaves joined by `and`.
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
    accounts: [] as FakeAccountRow[],
  };

  const db = {
    select() {
      return {
        from(table: unknown) {
          if (table === schema.accounts) {
            return {
              where(cond: unknown) {
                const filtered = state.accounts.filter((r) =>
                  rowMatchesWith(
                    r as unknown as Record<string, unknown>,
                    cond,
                    accountColumnKeyByRef,
                  ),
                );
                const result = Promise.resolve(filtered.map(cloneRow)) as Promise<
                  FakeAccountRow[]
                > & {
                  orderBy: () => Promise<FakeAccountRow[]>;
                };
                result.orderBy = () =>
                  Promise.resolve(
                    [...filtered]
                      .sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''))
                      .map(cloneRow),
                  );
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
          throw new Error('fakeDb: unsupported insert().values() table');
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

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const ADMIN: FakeUserRow = {
  id: 'user-admin',
  orgId: ORG_A,
  email: 'admin@invoicing.test',
  passwordHash: '',
  role: 'admin',
};

function makeAccount(overrides: Partial<FakeAccountRow>): FakeAccountRow {
  return {
    id: randomUUID(),
    orgId: ORG_A,
    code: null,
    name: 'Account',
    type: 'asset',
    subtype: null,
    parentId: null,
    currency: 'USD',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function buildTestApp(users: FakeUserRow[] = [ADMIN]) {
  const { db, state } = createFakeDb();
  const password = 'correct horse battery staple';
  state.users = await Promise.all(
    users.map(async (u) => ({ ...u, passwordHash: await hashPassword(password) })),
  );
  const app = buildApp({ pool: fakePool(), db });
  return { app, state, password };
}

function sidCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === '__session')?.value;
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

describe('GET /api/accounts', () => {
  it('returns 401 without a session cookie', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('lists the 4 seeded accounts for the caller org, excluding other orgs', async () => {
    const { app, state, password } = await buildTestApp();
    state.accounts = [
      makeAccount({ code: '1200', name: 'Accounts Receivable', subtype: 'accounts_receivable' }),
      makeAccount({ code: '1499', name: 'Undeposited Funds', subtype: 'undeposited_funds' }),
      makeAccount({ code: '1000', name: 'Business Checking', subtype: 'bank' }),
      makeAccount({
        code: '4000',
        name: 'Sales Income',
        type: 'income',
        subtype: 'sales_income',
      }),
      makeAccount({ code: '9999', name: 'Other Org Account', orgId: ORG_B }),
    ];
    const sid = await loginAs(app, ADMIN, password);

    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      cookies: { __session: sid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ code: string; subtype: string }>;
    expect(body).toHaveLength(4);
    expect(body.map((a) => a.code).sort()).toEqual(['1000', '1200', '1499', '4000']);

    await app.close();
  });

  it('excludes inactive accounts by default, includes them with ?includeInactive=true', async () => {
    const { app, state, password } = await buildTestApp();
    state.accounts = [
      makeAccount({ code: '1000', name: 'Active', isActive: true }),
      makeAccount({ code: '2000', name: 'Inactive', isActive: false }),
    ];
    const sid = await loginAs(app, ADMIN, password);

    const active = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      cookies: { __session: sid },
    });
    expect(active.json()).toHaveLength(1);

    const all = await app.inject({
      method: 'GET',
      url: '/api/accounts?includeInactive=true',
      cookies: { __session: sid },
    });
    expect(all.json()).toHaveLength(2);

    await app.close();
  });
});
