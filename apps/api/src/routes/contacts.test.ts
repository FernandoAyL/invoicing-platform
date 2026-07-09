import { randomUUID } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import { createContact } from '../contacts/service.ts';
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

interface FakeContactRow {
  id: string;
  orgId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  isCustomer: boolean;
  isVendor: boolean;
  isEmployee: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeSyncLink {
  orgId: string;
  entityType: string;
  localId: string;
  state: string;
  qboId?: string | null;
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

// Reverse map from a drizzle column reference (identity) back to the JS field
// name, so `where()` conditions built from `eq(contacts.x, v)` can be
// evaluated against plain in-memory rows.
const contactColumnKeyByRef = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.contacts)).map(([key, col]) => [col, key]),
);

interface SqlChunk {
  queryChunks?: SqlChunk[];
  constructor: { name: string };
  value?: unknown;
  table?: unknown;
  name?: unknown;
}

// `eq`/`and` conditions are opaque SQL fragment trees at runtime. Since the
// contacts service only ever builds simple `eq` leaves joined by `and`, a
// depth-first walk collecting (Column, Param) pairs in encounter order is
// enough to reconstruct an equality filter without depending on more of
// drizzle's internals than necessary.
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

function rowMatches(row: FakeContactRow, cond: unknown): boolean {
  return rowMatchesWith(row as unknown as Record<string, unknown>, cond, contactColumnKeyByRef);
}

function cloneRow<T>(row: T): T {
  return { ...row };
}

function createFakeDb(opts: { failAuditInsert?: boolean } = {}) {
  const state = {
    users: [] as FakeUserRow[],
    sessions: [] as FakeSessionRow[],
    contacts: [] as FakeContactRow[],
    syncLinks: [] as FakeSyncLink[],
    auditLogs: [] as FakeAuditRow[],
  };

  // Emulates the contacts service's `contacts LEFT JOIN sync_links` projection
  // (listContactsWithSync/getContactWithSync) — the raw `.where()` path below is
  // untouched for the internal callers that still read plain rows.
  function joinContactsSyncLinks() {
    return {
      where(cond: unknown) {
        const filtered = state.contacts.filter((r) => rowMatches(r, cond));
        const project = (rows: FakeContactRow[]) =>
          rows.map((c) => {
            const link = state.syncLinks.find(
              (l) => l.orgId === c.orgId && l.entityType === 'contact' && l.localId === c.id,
            );
            return {
              contact: cloneRow(c),
              syncState: link ? link.state : 'pending',
              qboId: link ? (link.qboId ?? null) : null,
            };
          });
        const joined = project(filtered);
        const result = Promise.resolve(joined) as Promise<typeof joined> & {
          orderBy: () => Promise<typeof joined>;
          limit: (n: number) => Promise<typeof joined>;
        };
        result.orderBy = () =>
          Promise.resolve(
            project([...filtered].sort((a, b) => a.displayName.localeCompare(b.displayName))),
          );
        result.limit = (n: number) => Promise.resolve(joined.slice(0, n));
        return result;
      },
    };
  }

  function selectContacts() {
    return {
      leftJoin(joinTable: unknown) {
        if (joinTable !== schema.syncLinks) throw new Error('fakeDb: unsupported leftJoin target');
        return joinContactsSyncLinks();
      },
      where(cond: unknown) {
        const filtered = state.contacts.filter((r) => rowMatches(r, cond));
        // The result must both be directly awaitable (the service never
        // chains `.orderBy()`/`.limit()` in some call sites) and support
        // chaining. Attaching methods onto a real Promise instance (rather
        // than a plain object with an own `then`) keeps it a genuine
        // thenable without tripping the no-fake-thenable lint rule.
        const result = Promise.resolve(filtered.map(cloneRow)) as Promise<FakeContactRow[]> & {
          orderBy: () => Promise<FakeContactRow[]>;
          limit: (n: number) => Promise<FakeContactRow[]>;
        };
        result.orderBy = () =>
          Promise.resolve(
            [...filtered].sort((a, b) => a.displayName.localeCompare(b.displayName)).map(cloneRow),
          );
        result.limit = (n: number) => Promise.resolve(filtered.slice(0, n).map(cloneRow));
        return result;
      },
    };
  }

  const baseDb = {
    select() {
      return {
        from(table: unknown) {
          if (table === schema.contacts) return selectContacts();
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
          // The insert must happen here, in `values()`: `createSession` never
          // calls `.returning()`, it just awaits `.values()` directly. The
          // returned value is a real Promise (awaitable as-is) with
          // `.returning()` attached (used by the contacts service).
          if (table === schema.sessions) {
            state.sessions.push(vals as unknown as FakeSessionRow);
            return Promise.resolve(undefined);
          }
          if (table === schema.contacts) {
            const row: FakeContactRow = {
              id: randomUUID(),
              orgId: vals.orgId as string,
              displayName: vals.displayName as string,
              email: (vals.email as string | undefined) ?? null,
              phone: (vals.phone as string | undefined) ?? null,
              isCustomer: vals.isCustomer as boolean,
              isVendor: vals.isVendor as boolean,
              isEmployee: vals.isEmployee as boolean,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            state.contacts.push(row);
            const result = Promise.resolve([cloneRow(row)]) as Promise<FakeContactRow[]> & {
              returning: () => Promise<FakeContactRow[]>;
            };
            result.returning = () => Promise.resolve([cloneRow(row)]);
            return result;
          }
          if (table === schema.syncAuditLogs) {
            if (opts.failAuditInsert) {
              throw new Error('simulated audit write failure');
            }
            const row: FakeAuditRow = {
              id: randomUUID(),
              orgId: vals.orgId as string,
              entityType: (vals.entityType as string | undefined) ?? null,
              localId: (vals.localId as string | undefined) ?? null,
              action: vals.action as string,
              direction: vals.direction as string,
              outcome: vals.outcome as string,
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
                async returning(selection?: Record<string, unknown>) {
                  if (table !== schema.contacts) {
                    throw new Error('fakeDb: unsupported update() table');
                  }
                  const matched = state.contacts.filter((r) => rowMatches(r, cond));
                  for (const row of matched) Object.assign(row, vals);
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

  const db = {
    ...baseDb,
    // Models real commit/rollback: the callback runs against the same table
    // handlers (fine, since none of the calling code nests transactions), and
    // a thrown error restores the pre-transaction snapshot so mutation + audit
    // rise or fall together, mirroring a real Postgres transaction.
    async transaction<T>(fn: (tx: typeof baseDb) => Promise<T>): Promise<T> {
      const snapshot = {
        contacts: state.contacts.map(cloneRow),
        auditLogs: state.auditLogs.map(cloneRow),
      };
      try {
        return await fn(baseDb);
      } catch (err) {
        state.contacts = snapshot.contacts;
        state.auditLogs = snapshot.auditLogs;
        throw err;
      }
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

describe('POST /api/contacts', () => {
  it('returns 401 without a session cookie, no row created', async () => {
    const { app, state } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      payload: { displayName: 'Acme Co' },
    });
    expect(res.statusCode).toBe(401);
    expect(state.contacts).toHaveLength(0);
    await app.close();
  });

  it('creates a contact defaulting isCustomer to true, and audits the creation', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);

    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Acme Co', email: 'billing@acme.test' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      displayName: 'Acme Co',
      email: 'billing@acme.test',
      isCustomer: true,
      isVendor: false,
      isEmployee: false,
      isActive: true,
    });
    expect(body.id).toBeDefined();

    expect(state.auditLogs).toHaveLength(1);
    expect(state.auditLogs[0]).toMatchObject({
      orgId: ORG_A,
      entityType: 'contact',
      localId: body.id,
      action: 'create',
      direction: 'local',
      outcome: 'success',
      userId: ADMIN.id,
    });

    await app.close();
  });

  it('returns 400 for an empty displayName', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);

    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 for an unknown body field', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);

    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Acme Co', unknownField: 'x' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 for an invalid email', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);

    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Acme Co', email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /api/contacts', () => {
  it('lists contacts scoped to the caller org, excluding archived by default', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);

    await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Beta Co' },
    });
    const create = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Alpha Co' },
    });
    const alphaId = create.json().id as string;

    await app.inject({
      method: 'DELETE',
      url: `/api/contacts/${alphaId}`,
      cookies: { __session: sid },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/contacts',
      cookies: { __session: sid },
    });
    expect(list.statusCode).toBe(200);
    const names = list.json().map((c: { displayName: string }) => c.displayName);
    expect(names).toEqual(['Beta Co']);

    const withInactive = await app.inject({
      method: 'GET',
      url: '/api/contacts?includeInactive=true',
      cookies: { __session: sid },
    });
    expect(
      withInactive
        .json()
        .map((c: { displayName: string }) => c.displayName)
        .sort(),
    ).toEqual(['Alpha Co', 'Beta Co']);

    await app.close();
  });

  it('filters by role', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);

    await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Vendor Co', isCustomer: false, isVendor: true },
    });
    await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Customer Co' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/contacts?role=vendor',
      cookies: { __session: sid },
    });
    expect(res.json().map((c: { displayName: string }) => c.displayName)).toEqual(['Vendor Co']);

    await app.close();
  });
});

describe('GET /api/contacts/:id', () => {
  it('returns 404 for a contact belonging to another org', async () => {
    const otherOrgUser: FakeUserRow = {
      ...ADMIN,
      id: 'user-b',
      orgId: ORG_B,
      email: 'other-admin@invoicing.test',
    };
    const { app, state, password } = await buildTestApp([ADMIN, otherOrgUser]);
    const sidA = await loginAs(app, ADMIN, password);

    const create = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sidA },
      payload: { displayName: 'Acme Co' },
    });
    const contactId = create.json().id as string;

    state.sessions = [];
    const otherLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: otherOrgUser.email, password },
    });
    const sidB = sidCookie(otherLogin) as string;

    const res = await app.inject({
      method: 'GET',
      url: `/api/contacts/${contactId}`,
      cookies: { __session: sidB },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('returns 400 for a non-uuid id', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);

    const res = await app.inject({
      method: 'GET',
      url: '/api/contacts/not-a-uuid',
      cookies: { __session: sid },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 for a random uuid', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);

    const res = await app.inject({
      method: 'GET',
      url: `/api/contacts/${randomUUID()}`,
      cookies: { __session: sid },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns the contact when found, and GET does not write an audit row', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);
    const create = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Acme Co' },
    });
    const contactId = create.json().id as string;

    const res = await app.inject({
      method: 'GET',
      url: `/api/contacts/${contactId}`,
      cookies: { __session: sid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe('Acme Co');
    // Only the create audit row should exist; the read must not add one.
    expect(state.auditLogs).toHaveLength(1);
    expect(state.auditLogs[0]?.action).toBe('create');
    await app.close();
  });
});

describe('PATCH /api/contacts/:id', () => {
  it('updates provided fields and audits the update', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);
    const create = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Acme Co' },
    });
    const contactId = create.json().id as string;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${contactId}`,
      cookies: { __session: sid },
      payload: { phone: '+1-555-0100' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().phone).toBe('+1-555-0100');

    const updateAudits = state.auditLogs.filter((a) => a.action === 'update');
    expect(updateAudits).toHaveLength(1);
    expect(updateAudits[0]).toMatchObject({
      orgId: ORG_A,
      entityType: 'contact',
      localId: contactId,
      direction: 'local',
      outcome: 'success',
      userId: ADMIN.id,
      detail: { fields: ['phone'] },
    });
    await app.close();
  });

  it('returns 400 for an empty body', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);
    const create = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Acme Co' },
    });
    const contactId = create.json().id as string;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${contactId}`,
      cookies: { __session: sid },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 for an unknown field', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);
    const create = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Acme Co' },
    });
    const contactId = create.json().id as string;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${contactId}`,
      cookies: { __session: sid },
      payload: { nope: true },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 for a contact not in the org, and does not write an audit row', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${randomUUID()}`,
      cookies: { __session: sid },
      payload: { phone: '555' },
    });
    expect(res.statusCode).toBe(404);
    expect(state.auditLogs).toHaveLength(0);
    await app.close();
  });
});

describe('DELETE /api/contacts/:id (archive)', () => {
  it('archives a contact, audits it, and is idempotent', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);
    const create = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Acme Co' },
    });
    const contactId = create.json().id as string;

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/contacts/${contactId}`,
      cookies: { __session: sid },
    });
    expect(first.statusCode).toBe(204);

    const archiveAudits = state.auditLogs.filter((a) => a.action === 'archive');
    expect(archiveAudits).toHaveLength(1);
    expect(archiveAudits[0]).toMatchObject({
      orgId: ORG_A,
      entityType: 'contact',
      localId: contactId,
      direction: 'local',
      outcome: 'success',
      userId: ADMIN.id,
    });

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/contacts/${contactId}`,
      cookies: { __session: sid },
    });
    expect(second.statusCode).toBe(204);
    // Archiving an already-archived contact is still a real matched update,
    // so it audits again (idempotent at the HTTP layer, logged each time).
    expect(state.auditLogs.filter((a) => a.action === 'archive')).toHaveLength(2);

    await app.close();
  });

  it('returns 404 for a contact that does not exist in the org, and does not write an audit row', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAs(app, ADMIN, password);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/contacts/${randomUUID()}`,
      cookies: { __session: sid },
    });
    expect(res.statusCode).toBe(404);
    expect(state.auditLogs).toHaveLength(0);
    await app.close();
  });
});

describe('audit atomicity', () => {
  it('rolls back the contact row if the audit write fails mid-transaction', async () => {
    const { db, state } = createFakeDb({ failAuditInsert: true });

    await expect(
      createContact(db, ORG_A, ADMIN.id, { displayName: 'Should Not Persist' }),
    ).rejects.toThrow('simulated audit write failure');

    expect(state.contacts).toHaveLength(0);
    expect(state.auditLogs).toHaveLength(0);
  });
});
