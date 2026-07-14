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

function fakePool(): pg.Pool {
  return { query: async () => ({ rows: [] }), end: async () => {} } as unknown as pg.Pool;
}

interface SqlChunk {
  queryChunks?: SqlChunk[];
  constructor: { name: string };
  value?: unknown;
  table?: unknown;
  name?: unknown;
}

// Flattened token stream for a drizzle `and(eq(...), isNull(...), ...)` condition tree. Each
// leaf comparison (`eq`/`isNull`) contributes a Column token plus either a trailing Param token
// (`eq`) or an "is null" StringChunk (`isNull`) — walked as a flat sequence (not paired up by
// array index) so `isNull()` conditions (which have a column but no Param) can't desync a
// positional columns[]/params[] zip. See `extractFieldConditions` below.
type Token =
  | { kind: 'column'; col: SqlChunk }
  | { kind: 'param'; value: unknown }
  | { kind: 'text'; value: string };

function flattenTokens(node: SqlChunk | null | undefined, acc: Token[] = []): Token[] {
  if (!node) return acc;
  if (Array.isArray(node.queryChunks)) {
    for (const chunk of node.queryChunks) flattenTokens(chunk, acc);
    return acc;
  }
  const ctorName = node.constructor?.name;
  if (ctorName === 'Param') {
    acc.push({ kind: 'param', value: node.value });
  } else if (ctorName === 'StringChunk') {
    acc.push({ kind: 'text', value: String(node.value ?? '') });
  } else if (node.table && typeof node.name === 'string') {
    acc.push({ kind: 'column', col: node });
  }
  return acc;
}

interface FieldCondition {
  column: SqlChunk;
  op: 'eq' | 'isNull';
  value?: unknown;
}

/** For each Column token, scans forward (until the next Column) for either a Param (`eq`) or an
 * "is null" text fragment (`isNull`) — order-independent within that span, so it doesn't matter
 * whether the column or the comparator text comes first in the chunk tree. */
function extractFieldConditions(node: SqlChunk | null | undefined): FieldCondition[] {
  const tokens = flattenTokens(node);
  const conditions: FieldCondition[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token?.kind !== 'column') continue;
    let isNullOp = false;
    let paramValue: unknown;
    let foundParam = false;
    for (let j = i + 1; j < tokens.length && tokens[j]?.kind !== 'column'; j++) {
      const next = tokens[j];
      if (next?.kind === 'param') {
        foundParam = true;
        paramValue = next.value;
      } else if (next?.kind === 'text' && /is null/i.test(next.value)) {
        isNullOp = true;
      }
    }
    if (isNullOp) {
      conditions.push({ column: token.col, op: 'isNull' });
    } else if (foundParam) {
      conditions.push({ column: token.col, op: 'eq', value: paramValue });
    }
  }
  return conditions;
}

function buildColumnMap(table: unknown): Map<unknown, string> {
  return new Map(
    Object.entries(getTableColumns(table as Parameters<typeof getTableColumns>[0])).map(
      ([key, col]) => [col, key],
    ),
  );
}

const COLUMN_MAPS = new Map<unknown, Map<unknown, string>>([
  [schema.users, buildColumnMap(schema.users)],
  [schema.contacts, buildColumnMap(schema.contacts)],
  [schema.accounts, buildColumnMap(schema.accounts)],
  [schema.transactions, buildColumnMap(schema.transactions)],
  [schema.transactionLines, buildColumnMap(schema.transactionLines)],
  [schema.ledgerEntries, buildColumnMap(schema.ledgerEntries)],
]);

function rowMatches(table: unknown, row: Record<string, unknown>, cond: unknown): boolean {
  const columnMap = COLUMN_MAPS.get(table);
  if (!columnMap) throw new Error('fakeDb: unmapped table in where clause');
  const conditions = extractFieldConditions(cond as SqlChunk);
  if (conditions.length === 0) return true;
  return conditions.every((condition) => {
    const key = columnMap.get(condition.column);
    if (!key) throw new Error('fakeDb: unmapped column in where clause');
    if (condition.op === 'isNull') return row[key] === null || row[key] === undefined;
    return row[key] === condition.value;
  });
}

function cloneRow<T>(row: T): T {
  return { ...row };
}

// Resolves a `.set()` value that may be a drizzle `sql` fragment (30022/30024: the atomic
// `sql\`${col} + 1\`` version bump) rather than a plain JS value — this fake DB otherwise does a
// naive `Object.assign(row, vals)`, which would stash the raw SQL AST object into the row instead
// of the incremented number. Only supports the one shape actually produced in this codebase
// (`${column} + 1`); anything else throws loudly rather than silently corrupting state.
function resolveSetValue(table: unknown, row: Record<string, unknown>, value: unknown): unknown {
  if (!value || typeof value !== 'object' || !Array.isArray((value as SqlChunk).queryChunks)) {
    return value;
  }
  const columnMap = COLUMN_MAPS.get(table);
  if (!columnMap) throw new Error('fakeDb: unmapped table in set() sql value');
  const tokens = flattenTokens(value as SqlChunk);
  const columnToken = tokens.find((t) => t.kind === 'column');
  const textToken = tokens.find((t) => t.kind === 'text' && /\+\s*1/.test(t.value));
  if (columnToken?.kind !== 'column' || !textToken) {
    throw new Error('fakeDb: unsupported set() sql expression');
  }
  const key = columnMap.get(columnToken.col);
  if (!key) throw new Error('fakeDb: unmapped column in set() sql value');
  return (row[key] as number) + 1;
}

interface FakeSyncLink {
  orgId: string;
  entityType: string;
  localId: string;
  state: string;
  qboId?: string | null;
}

interface State {
  users: FakeUserRow[];
  sessions: FakeSessionRow[];
  contacts: Record<string, unknown>[];
  accounts: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  transactionLines: Record<string, unknown>[];
  ledgerEntries: Record<string, unknown>[];
  auditLogs: Record<string, unknown>[];
  syncLinks: FakeSyncLink[];
}

function rowsForTable(state: State, table: unknown): Record<string, unknown>[] {
  if (table === schema.users) return state.users as unknown as Record<string, unknown>[];
  if (table === schema.contacts) return state.contacts;
  if (table === schema.accounts) return state.accounts;
  if (table === schema.transactions) return state.transactions;
  if (table === schema.transactionLines) return state.transactionLines;
  if (table === schema.ledgerEntries) return state.ledgerEntries;
  throw new Error('fakeDb: unsupported select().from() table');
}

function insertRow(
  state: State,
  table: unknown,
  vals: Record<string, unknown>,
): Record<string, unknown> {
  const now = new Date();
  if (table === schema.contacts) {
    const row = {
      id: randomUUID(),
      orgId: vals.orgId,
      displayName: vals.displayName,
      email: vals.email ?? null,
      phone: vals.phone ?? null,
      isCustomer: vals.isCustomer ?? true,
      isVendor: vals.isVendor ?? false,
      isEmployee: vals.isEmployee ?? false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    state.contacts.push(row);
    return row;
  }
  if (table === schema.transactions) {
    const row = {
      id: randomUUID(),
      orgId: vals.orgId,
      type: vals.type,
      status: vals.status ?? 'draft',
      contactId: vals.contactId ?? null,
      docNumber: vals.docNumber ?? null,
      txnDate: vals.txnDate,
      dueDate: vals.dueDate ?? null,
      currency: vals.currency ?? 'USD',
      memo: vals.memo ?? null,
      subtotal: vals.subtotal ?? '0.00',
      total: vals.total ?? '0.00',
      balance: vals.balance ?? '0.00',
      version: vals.version ?? 0,
      createdBy: vals.createdBy ?? null,
      deletedAt: vals.deletedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    state.transactions.push(row);
    return row;
  }
  if (table === schema.transactionLines) {
    const row = {
      id: randomUUID(),
      orgId: vals.orgId,
      transactionId: vals.transactionId,
      lineNumber: vals.lineNumber,
      itemId: vals.itemId ?? null,
      accountId: vals.accountId,
      description: vals.description ?? null,
      quantity: vals.quantity ?? '1',
      unitPrice: vals.unitPrice ?? '0.00',
      amount: vals.amount ?? '0.00',
      createdAt: now,
      updatedAt: now,
    };
    state.transactionLines.push(row);
    return row;
  }
  if (table === schema.ledgerEntries) {
    const row = {
      id: randomUUID(),
      orgId: vals.orgId,
      transactionId: vals.transactionId,
      accountId: vals.accountId,
      contactId: vals.contactId ?? null,
      entryDate: vals.entryDate,
      debit: vals.debit ?? '0.00',
      credit: vals.credit ?? '0.00',
      createdAt: now,
    };
    state.ledgerEntries.push(row);
    return row;
  }
  if (table === schema.syncAuditLogs) {
    const row = {
      id: randomUUID(),
      orgId: vals.orgId,
      entityType: vals.entityType ?? null,
      localId: vals.localId ?? null,
      action: vals.action,
      direction: vals.direction ?? 'local',
      outcome: vals.outcome ?? 'success',
      detail: vals.detail ?? null,
      userId: vals.userId ?? null,
      createdAt: now,
    };
    state.auditLogs.push(row);
    return row;
  }
  throw new Error('fakeDb: unsupported insert().values() table');
}

// Mirrors `rowsForTable` but also covers `syncAuditLogs`, which `insertRow` writes to but selects
// never target — needed so insert-undo (below) can locate/remove a just-inserted audit row too.
function arrayForTable(state: State, table: unknown): Record<string, unknown>[] {
  if (table === schema.syncAuditLogs) return state.auditLogs;
  return rowsForTable(state, table);
}

// 30022/30024: per-transaction undo log, replacing a former whole-array snapshot/restore. A
// whole-array restore would incorrectly wipe out another transaction's writes that committed
// concurrently while this one was still in flight; it also has a subtler problem this file hit
// directly — the snapshot itself (`state.transactions.map(cloneRow)`) unconditionally reads every
// row's every field up front, which fires BEFORE the transaction body's own first read. For a
// test simulating a version race by trapping a one-shot read of `.version`, that premature snapshot
// read silently consumes the trap before `loadInvoiceForUpdate` ever runs. An undo log has no such
// up-front read — it only captures a row's prior state lazily, at the moment that row is actually
// mutated — so it doesn't have this problem either. Mirrors the identical fix already applied to
// invoices/service.test.ts and payments/service.test.ts.
function makeDbApi(state: State, undoLog: Array<() => void>) {
  return {
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
          const rows = rowsForTable(state, table);
          const whereChain = () => ({
            where(cond?: unknown) {
              const filtered = cond ? rows.filter((r) => rowMatches(table, r, cond)) : rows.slice();
              const result = Promise.resolve(filtered.map(cloneRow)) as Promise<
                Record<string, unknown>[]
              > & {
                limit: (n: number) => Promise<Record<string, unknown>[]>;
                orderBy: () => Promise<Record<string, unknown>[]>;
              };
              result.limit = (n: number) => Promise.resolve(filtered.slice(0, n).map(cloneRow));
              result.orderBy = () => Promise.resolve(filtered.map(cloneRow));
              return result;
            },
          });

          // Emulates the invoices service's `transactions LEFT JOIN
          // sync_links` (see invoices/service.ts). Other `.from(transactions)`
          // call sites never call `.leftJoin` and are unaffected.
          if (table === schema.transactions) {
            return {
              ...whereChain(),
              leftJoin(joinTable: unknown) {
                if (joinTable !== schema.syncLinks) {
                  throw new Error('fakeDb: unsupported leftJoin target');
                }
                return {
                  where(cond?: unknown) {
                    const filtered = cond
                      ? rows.filter((r) => rowMatches(table, r, cond))
                      : rows.slice();
                    const joined = filtered.map((txnRow) => {
                      const link = state.syncLinks.find(
                        (l) =>
                          l.orgId === txnRow.orgId &&
                          l.entityType === 'transaction' &&
                          l.localId === txnRow.id,
                      );
                      return {
                        txn: cloneRow(txnRow),
                        syncState: link ? link.state : 'pending',
                        qboId: link ? (link.qboId ?? null) : null,
                      };
                    });
                    const result = Promise.resolve(joined) as Promise<
                      { txn: Record<string, unknown>; syncState: string; qboId: string | null }[]
                    > & {
                      limit: (
                        n: number,
                      ) => Promise<
                        { txn: Record<string, unknown>; syncState: string; qboId: string | null }[]
                      >;
                      orderBy: () => Promise<
                        { txn: Record<string, unknown>; syncState: string; qboId: string | null }[]
                      >;
                    };
                    result.limit = (n: number) => Promise.resolve(joined.slice(0, n));
                    result.orderBy = () => Promise.resolve(joined);
                    return result;
                  },
                };
              },
            };
          }

          return whereChain();
        },
      };
    },
    insert(table: unknown) {
      return {
        values(vals: Record<string, unknown> | Record<string, unknown>[]) {
          if (table === schema.sessions) {
            const sessionRow = vals as unknown as FakeSessionRow;
            state.sessions.push(sessionRow);
            undoLog.push(() => {
              state.sessions = state.sessions.filter((s) => s !== sessionRow);
            });
            return Promise.resolve(undefined);
          }
          const list = Array.isArray(vals) ? vals : [vals];
          const created = list.map((v) => insertRow(state, table, v));
          for (const row of created) {
            undoLog.push(() => {
              const arr = arrayForTable(state, table);
              const idx = arr.indexOf(row);
              if (idx !== -1) arr.splice(idx, 1);
            });
          }
          const result = Promise.resolve(created.map(cloneRow)) as Promise<
            Record<string, unknown>[]
          > & { returning: () => Promise<Record<string, unknown>[]> };
          result.returning = () => Promise.resolve(created.map(cloneRow));
          return result;
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
                  const rows = rowsForTable(state, table);
                  const matched = rows.filter((r) => rowMatches(table, r, cond));
                  for (const row of matched) {
                    const previous = { ...row };
                    undoLog.push(() => Object.assign(row, previous));
                    const resolved = Object.fromEntries(
                      Object.entries(vals).map(([k, v]) => [k, resolveSetValue(table, row, v)]),
                    );
                    Object.assign(row, resolved);
                  }
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
        async where(cond: unknown) {
          if (table === schema.sessions) {
            const removed = state.sessions;
            state.sessions = [];
            undoLog.push(() => {
              state.sessions = removed;
            });
          } else if (table === schema.transactionLines) {
            const removed = state.transactionLines.filter((r) => rowMatches(table, r, cond));
            state.transactionLines = state.transactionLines.filter(
              (r) => !rowMatches(table, r, cond),
            );
            undoLog.push(() => {
              state.transactionLines.push(...removed);
            });
          } else {
            throw new Error('fakeDb: unsupported delete() table');
          }
          return undefined;
        },
      };
    },
  };
}

function createFakeDb() {
  const state: State = {
    users: [],
    sessions: [],
    contacts: [],
    accounts: [],
    transactions: [],
    transactionLines: [],
    ledgerEntries: [],
    auditLogs: [],
    syncLinks: [],
  };

  const baseDb = makeDbApi(state, []);

  const db = {
    ...baseDb,
    async transaction<T>(fn: (tx: ReturnType<typeof makeDbApi>) => Promise<T>): Promise<T> {
      const undoLog: Array<() => void> = [];
      const tx = makeDbApi(state, undoLog);
      try {
        return await fn(tx);
      } catch (err) {
        for (let i = undoLog.length - 1; i >= 0; i--) undoLog[i]();
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

async function buildTestApp() {
  const { db, state } = createFakeDb();
  const password = 'correct horse battery staple';
  state.users = [{ ...ADMIN, passwordHash: await hashPassword(password) }];
  state.accounts.push(
    {
      id: 'acct-ar',
      orgId: ORG_A,
      code: '1200',
      name: 'Accounts Receivable',
      type: 'asset',
      subtype: 'accounts_receivable',
      isActive: true,
    },
    {
      id: 'acct-income',
      orgId: ORG_A,
      code: '4000',
      name: 'Sales Income',
      type: 'income',
      subtype: 'sales_income',
      isActive: true,
    },
  );
  const app = buildApp({ pool: fakePool(), db });
  return { app, state, password };
}

function sidCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === '__session')?.value;
}

async function loginAsAdmin(app: ReturnType<typeof buildApp>, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: ADMIN.email, password },
  });
  const sid = sidCookie(res);
  if (!sid) throw new Error('login failed in test setup');
  return sid;
}

async function createCustomer(app: ReturnType<typeof buildApp>, sid: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/contacts',
    cookies: { __session: sid },
    payload: { displayName: 'Acme Co' },
  });
  return res.json().id as string;
}

describe('POST /api/invoices', () => {
  it('returns 401 without a session cookie', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      payload: {
        contactId: randomUUID(),
        txnDate: '2026-07-04',
        lines: [{ quantity: 1, unitPrice: 100 }],
      },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('creates an open invoice with balanced ledger postings and an audit row', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const contactId = await createCustomer(app, sid);

    const res = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { __session: sid },
      payload: {
        contactId,
        txnDate: '2026-07-04',
        lines: [{ quantity: 1, unitPrice: 100 }],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('open');
    expect(body.total).toBe('100.00');
    expect(body.balance).toBe('100.00');
    expect(state.ledgerEntries).toHaveLength(2);
    expect(
      state.auditLogs.filter((a) => a.action === 'create' && a.entityType === 'transaction'),
    ).toHaveLength(1);

    await app.close();
  });

  it('returns 400 for empty lines', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const contactId = await createCustomer(app, sid);

    const res = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { __session: sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 for quantity 0 and for negative unitPrice', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const contactId = await createCustomer(app, sid);

    const zeroQty = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { __session: sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 0, unitPrice: 10 }] },
    });
    expect(zeroQty.statusCode).toBe(400);

    const negPrice = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { __session: sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: -10 }] },
    });
    expect(negPrice.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 for a non-uuid contactId', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);

    const res = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { __session: sid },
      payload: {
        contactId: 'not-a-uuid',
        txnDate: '2026-07-04',
        lines: [{ quantity: 1, unitPrice: 10 }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 422 for a contact that is not a customer', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);

    const vendorRes = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { __session: sid },
      payload: { displayName: 'Vendor Co', isCustomer: false, isVendor: true },
    });
    const vendorId = vendorRes.json().id as string;

    const res = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { __session: sid },
      payload: {
        contactId: vendorId,
        txnDate: '2026-07-04',
        lines: [{ quantity: 1, unitPrice: 10 }],
      },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

describe('GET /api/invoices and /api/invoices/:id', () => {
  it('lists invoices scoped to the org and gets one by id', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const contactId = await createCustomer(app, sid);

    const create = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { __session: sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 50 }] },
    });
    const invoiceId = create.json().id as string;

    const list = await app.inject({
      method: 'GET',
      url: '/api/invoices',
      cookies: { __session: sid },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].syncState).toBe('pending');

    const get = await app.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().id).toBe(invoiceId);
    expect(get.json().syncState).toBe('pending');
  });

  it('returns 404 for an unknown invoice id', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);

    const res = await app.inject({
      method: 'GET',
      url: `/api/invoices/${randomUUID()}`,
      cookies: { __session: sid },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('PATCH /api/invoices/:id and POST /:id/void', () => {
  async function createInvoiceViaHttp(app: ReturnType<typeof buildApp>, sid: string) {
    const contactId = await createCustomer(app, sid);
    const create = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { __session: sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    });
    return create.json().id as string;
  }

  it('edits an open invoice, recomputing totals and bumping version', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoiceViaHttp(app, sid);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
      payload: { lines: [{ quantity: 2, unitPrice: 100 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe('200.00');
    expect(body.version).toBe(1);
    await app.close();
  });

  it('voids an open invoice, then rejects a second void with 409', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoiceViaHttp(app, sid);

    const first = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/void`,
      cookies: { __session: sid },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('void');
    expect(first.json().balance).toBe('0.00');

    const second = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/void`,
      cookies: { __session: sid },
    });
    expect(second.statusCode).toBe(409);
    await app.close();
  });

  it('rejects editing a voided invoice with 409', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoiceViaHttp(app, sid);

    await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/void`,
      cookies: { __session: sid },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
      payload: { memo: 'nope' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 400 for an empty PATCH body', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoiceViaHttp(app, sid);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  // Genuine concurrency at the service level (invoices/service.test.ts, see the "concurrent
  // version bump" describe block there) already proves the underlying fix under real interleaving
  // — that's the regression check that matters. What's under test HERE is purely the route's error
  // MAPPING (VersionConflictError -> 409 version_conflict), so instead of relying on two real
  // concurrent HTTP requests racing (confirmed empirically to run fully sequentially against this
  // fake DB — Fastify's auth/schema/hook pipeline adds enough extra microtask hops that two
  // `app.inject()` calls kicked off via `Promise.all` never actually interleave here, unlike the
  // bare service calls in invoices/service.test.ts), this deterministically simulates "another
  // writer committed a version bump in the instant between this request's read and its conditional
  // write" via a getter trap on the row: the request's own read of `.version` (`loadInvoiceForUpdate`,
  // via this fake DB's `.where().limit()` chain) sees the pre-bump value, while the row is already
  // internally holding the bumped value — so by the time the SAME request's conditional UPDATE
  // re-checks `version`, it finds no match. (Confirmed empirically this fake DB's `.where(cond)`
  // eagerly computes an unused clone of the matched rows before `.limit()` even runs, so
  // `loadInvoiceForUpdate`'s real read is actually the 2nd read of this row's `.version`, not the
  // 1st — both return the same pre-bump value, so the threshold below is 2, not 1.)
  it('30022/30024: a version conflict during PATCH maps to 409 version_conflict', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoiceViaHttp(app, sid);

    const row = state.transactions.find((t) => t.id === invoiceId);
    if (!row) throw new Error('test setup: invoice row missing');
    let reads = 0;
    const staleVersion = row.version as number;
    let currentVersion = staleVersion + 1;
    Object.defineProperty(row, 'version', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads <= 2 ? staleVersion : currentVersion;
      },
      set(v: number) {
        currentVersion = v;
      },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
      payload: { memo: 'edit' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('version_conflict');
    await app.close();
  });
});

describe('DELETE /api/invoices/:id (20009 — distinct from void)', () => {
  async function createInvoiceViaHttp(app: ReturnType<typeof buildApp>, sid: string) {
    const contactId = await createCustomer(app, sid);
    const create = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { __session: sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    });
    return create.json().id as string;
  }

  it('deletes an open invoice: 200, ledger zeroed, then 404s on GET and vanishes from the list', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoiceViaHttp(app, sid);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().balance).toBe('0.00');
    expect(
      state.ledgerEntries
        .filter((e) => e.transactionId === invoiceId)
        .reduce((sum, e) => sum + Number(e.debit) - Number(e.credit), 0),
    ).toBe(0);
    expect(state.auditLogs.some((a) => a.action === 'delete' && a.localId === invoiceId)).toBe(
      true,
    );

    const get = await app.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
    });
    expect(get.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: '/api/invoices',
      cookies: { __session: sid },
    });
    expect(list.json()).toHaveLength(0);

    await app.close();
  });

  it('deleting an already-deleted invoice is idempotent (200, no duplicate audit row)', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoiceViaHttp(app, sid);

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
    });
    expect(second.statusCode).toBe(200);

    // Anti-tautology: idempotent skip must not re-zero/re-audit — exactly one 'delete' audit row.
    expect(
      state.auditLogs.filter((a) => a.action === 'delete' && a.localId === invoiceId),
    ).toHaveLength(1);

    await app.close();
  });

  it('refuses to delete a paid/partially_paid invoice with 409 InvalidStateError', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoiceViaHttp(app, sid);

    // Simulate a paid invoice directly on the fake db state — recording a real payment through
    // this file's fakeDb would require wiring `paymentApplications` + an `undeposited_funds`
    // account it doesn't seed; the guard under test only cares about `transactions.status`.
    const txn = state.transactions.find((t) => t.id === invoiceId);
    if (!txn) throw new Error('setup: invoice row not found in fake state');
    txn.status = 'paid';

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toBe('invalid_state');

    await app.close();
  });

  it('returns 404 for a non-existent invoice', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/invoices/${randomUUID()}`,
      cookies: { __session: sid },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 401 without a session cookie', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/invoices/${randomUUID()}`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('a voided invoice can still be deleted (delete is more terminal than void)', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoiceViaHttp(app, sid);

    const voidRes = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/void`,
      cookies: { __session: sid },
    });
    expect(voidRes.statusCode).toBe(200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
    });
    expect(del.statusCode).toBe(200);
    // Delete is orthogonal to status: it stays 'void' (delete never introduces a new status
    // value), but the invoice is now gone from every read path.
    expect(del.json().status).toBe('void');

    const get = await app.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}`,
      cookies: { __session: sid },
    });
    expect(get.statusCode).toBe(404);

    await app.close();
  });
});
