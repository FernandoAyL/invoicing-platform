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

interface State {
  users: FakeUserRow[];
  sessions: FakeSessionRow[];
  contacts: Record<string, unknown>[];
  accounts: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  transactionLines: Record<string, unknown>[];
  ledgerEntries: Record<string, unknown>[];
  auditLogs: Record<string, unknown>[];
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
  };

  const baseDb = {
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
          return {
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
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(vals: Record<string, unknown> | Record<string, unknown>[]) {
          if (table === schema.sessions) {
            state.sessions.push(vals as unknown as FakeSessionRow);
            return Promise.resolve(undefined);
          }
          const list = Array.isArray(vals) ? vals : [vals];
          const created = list.map((v) => insertRow(state, table, v));
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
        async where(cond: unknown) {
          if (table === schema.sessions) {
            state.sessions = [];
          } else if (table === schema.transactionLines) {
            state.transactionLines = state.transactionLines.filter(
              (r) => !rowMatches(table, r, cond),
            );
          } else {
            throw new Error('fakeDb: unsupported delete() table');
          }
          return undefined;
        },
      };
    },
  };

  const db = {
    ...baseDb,
    async transaction<T>(fn: (tx: typeof baseDb) => Promise<T>): Promise<T> {
      const snapshot = {
        contacts: state.contacts.map(cloneRow),
        accounts: state.accounts.map(cloneRow),
        transactions: state.transactions.map(cloneRow),
        transactionLines: state.transactionLines.map(cloneRow),
        ledgerEntries: state.ledgerEntries.map(cloneRow),
        auditLogs: state.auditLogs.map(cloneRow),
      };
      try {
        return await fn(baseDb);
      } catch (err) {
        state.contacts = snapshot.contacts;
        state.accounts = snapshot.accounts;
        state.transactions = snapshot.transactions;
        state.transactionLines = snapshot.transactionLines;
        state.ledgerEntries = snapshot.ledgerEntries;
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
  return res.cookies.find((c) => c.name === 'sid')?.value;
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
    cookies: { sid },
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
      cookies: { sid },
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
      cookies: { sid },
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
      cookies: { sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 0, unitPrice: 10 }] },
    });
    expect(zeroQty.statusCode).toBe(400);

    const negPrice = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { sid },
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
      cookies: { sid },
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
      cookies: { sid },
      payload: { displayName: 'Vendor Co', isCustomer: false, isVendor: true },
    });
    const vendorId = vendorRes.json().id as string;

    const res = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { sid },
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
      cookies: { sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 50 }] },
    });
    const invoiceId = create.json().id as string;

    const list = await app.inject({ method: 'GET', url: '/api/invoices', cookies: { sid } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const get = await app.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}`,
      cookies: { sid },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().id).toBe(invoiceId);
  });

  it('returns 404 for an unknown invoice id', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);

    const res = await app.inject({
      method: 'GET',
      url: `/api/invoices/${randomUUID()}`,
      cookies: { sid },
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
      cookies: { sid },
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
      cookies: { sid },
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
      cookies: { sid },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('void');
    expect(first.json().balance).toBe('0.00');

    const second = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/void`,
      cookies: { sid },
    });
    expect(second.statusCode).toBe(409);
    await app.close();
  });

  it('rejects editing a voided invoice with 409', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoiceViaHttp(app, sid);

    await app.inject({ method: 'POST', url: `/api/invoices/${invoiceId}/void`, cookies: { sid } });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/invoices/${invoiceId}`,
      cookies: { sid },
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
      cookies: { sid },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
