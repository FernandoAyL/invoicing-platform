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
  [schema.paymentApplications, buildColumnMap(schema.paymentApplications)],
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
  paymentApplications: Record<string, unknown>[];
  auditLogs: Record<string, unknown>[];
}

function rowsForTable(state: State, table: unknown): Record<string, unknown>[] {
  if (table === schema.users) return state.users as unknown as Record<string, unknown>[];
  if (table === schema.contacts) return state.contacts;
  if (table === schema.accounts) return state.accounts;
  if (table === schema.transactions) return state.transactions;
  if (table === schema.transactionLines) return state.transactionLines;
  if (table === schema.ledgerEntries) return state.ledgerEntries;
  if (table === schema.paymentApplications) return state.paymentApplications;
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
  if (table === schema.paymentApplications) {
    const row = {
      id: randomUUID(),
      orgId: vals.orgId,
      paymentTxnId: vals.paymentTxnId,
      invoiceTxnId: vals.invoiceTxnId,
      amount: vals.amount,
      createdAt: now,
    };
    state.paymentApplications.push(row);
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
    paymentApplications: [],
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
          } else if (table === schema.paymentApplications) {
            state.paymentApplications = state.paymentApplications.filter(
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
        paymentApplications: state.paymentApplications.map(cloneRow),
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
        state.paymentApplications = snapshot.paymentApplications;
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
    {
      id: 'acct-undeposited',
      orgId: ORG_A,
      code: '1499',
      name: 'Undeposited Funds',
      type: 'asset',
      subtype: 'undeposited_funds',
      isActive: true,
    },
    {
      id: 'acct-bank',
      orgId: ORG_A,
      code: '1000',
      name: 'Business Checking',
      type: 'asset',
      subtype: 'bank',
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

async function createInvoice(app: ReturnType<typeof buildApp>, sid: string, total = 100) {
  const contactId = await createCustomer(app, sid);
  const res = await app.inject({
    method: 'POST',
    url: '/api/invoices',
    cookies: { sid },
    payload: {
      contactId,
      txnDate: '2026-07-04',
      lines: [{ quantity: 1, unitPrice: total }],
    },
  });
  return res.json().id as string;
}

describe('POST /api/invoices/:id/payments', () => {
  it('returns 401 without a session cookie', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${randomUUID()}/payments`,
      payload: { amount: 10, txnDate: '2026-07-05' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('records a partial payment: 201, invoice status/balance updated, ledger + audit written', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);

    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: 40, txnDate: '2026-07-05' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.invoice.status).toBe('partially_paid');
    expect(body.invoice.balance).toBe('60.00');
    expect(body.payment.amount).toBe('40.00');

    const paymentLedger = state.ledgerEntries.filter(
      (e: Record<string, unknown>) => e.transactionId === body.payment.id,
    );
    expect(paymentLedger).toHaveLength(2);
    expect(
      state.auditLogs.filter(
        (a: Record<string, unknown>) => a.action === 'payment' && a.localId === body.payment.id,
      ),
    ).toHaveLength(1);

    await app.close();
  });

  it('fully pays an invoice across two calls, ending at paid/0.00', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);

    await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: 40, txnDate: '2026-07-05' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: 60, txnDate: '2026-07-06' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().invoice.status).toBe('paid');
    expect(res.json().invoice.balance).toBe('0.00');
    await app.close();
  });

  it('returns 422 for an overpayment, nothing written', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);

    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: 120, txnDate: '2026-07-05' },
    });

    expect(res.statusCode).toBe(422);
    expect(state.paymentApplications).toHaveLength(0);
    await app.close();
  });

  it('returns 409 for paying an already-paid invoice', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);
    await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: 100, txnDate: '2026-07-05' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: 10, txnDate: '2026-07-06' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 409 for paying a voided invoice', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);
    await app.inject({ method: 'POST', url: `/api/invoices/${invoiceId}/void`, cookies: { sid } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: 10, txnDate: '2026-07-06' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 400 for amount 0, negative amount, and non-uuid invoice id', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);

    const zero = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: 0, txnDate: '2026-07-05' },
    });
    expect(zero.statusCode).toBe(400);

    const negative = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: -10, txnDate: '2026-07-05' },
    });
    expect(negative.statusCode).toBe(400);

    const badId = await app.inject({
      method: 'POST',
      url: '/api/invoices/not-a-uuid/payments',
      cookies: { sid },
      payload: { amount: 10, txnDate: '2026-07-05' },
    });
    expect(badId.statusCode).toBe(400);

    await app.close();
  });

  it('returns 404 for a non-existent invoice', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);

    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${randomUUID()}/payments`,
      cookies: { sid },
      payload: { amount: 10, txnDate: '2026-07-05' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /api/invoices/:id/payments', () => {
  it('lists payments recorded against an invoice', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);
    await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: 40, txnDate: '2026-07-05' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    await app.close();
  });
});

describe('POST /api/payments/:id/void', () => {
  it('voids a payment: invoice steps back down, double-void returns 409', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);
    const payRes = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: 100, txnDate: '2026-07-05' },
    });
    const paymentId = payRes.json().payment.id as string;

    const voidRes = await app.inject({
      method: 'POST',
      url: `/api/payments/${paymentId}/void`,
      cookies: { sid },
    });
    expect(voidRes.statusCode).toBe(200);
    const body = voidRes.json();
    expect(body.payment.status).toBe('void');
    expect(body.invoice.status).toBe('open');
    expect(body.invoice.balance).toBe('100.00');
    expect(
      state.paymentApplications.filter(
        (a: Record<string, unknown>) => a.paymentTxnId === paymentId,
      ),
    ).toHaveLength(0);

    const secondVoid = await app.inject({
      method: 'POST',
      url: `/api/payments/${paymentId}/void`,
      cookies: { sid },
    });
    expect(secondVoid.statusCode).toBe(409);

    await app.close();
  });

  it('returns 404 for a non-existent payment', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);

    const res = await app.inject({
      method: 'POST',
      url: `/api/payments/${randomUUID()}/void`,
      cookies: { sid },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 401 without a session cookie', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/payments/${randomUUID()}/void`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
