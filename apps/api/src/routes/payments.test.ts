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
  [schema.paymentApplications, buildColumnMap(schema.paymentApplications)],
  [schema.syncLinks, buildColumnMap(schema.syncLinks)],
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

// Resolves a `.set()` value that may be a drizzle `sql` fragment (30022: `recomputeInvoice`'s
// atomic `sql\`${col} + 1\`` version bump, and `bumpLocalVersion`'s equivalent on
// `sync_links.localVersion`) rather than a plain JS value — this fake DB otherwise does a naive
// `Object.assign(row, vals)`, which would stash the raw SQL AST object into the row instead of the
// incremented number. Only supports the one shape actually produced in this codebase
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
  // 30022: never seeded by this file's tests — registered purely so `bumpLocalVersion` (called
  // unconditionally from `recomputeInvoice`) always matches zero rows here rather than crashing on
  // an unmapped table. Direct `bumpLocalVersion` coverage lives in `qbo/sync-link-service.test.ts`.
  syncLinks: Record<string, unknown>[];
}

function rowsForTable(state: State, table: unknown): Record<string, unknown>[] {
  if (table === schema.users) return state.users as unknown as Record<string, unknown>[];
  if (table === schema.contacts) return state.contacts;
  if (table === schema.accounts) return state.accounts;
  if (table === schema.transactions) return state.transactions;
  if (table === schema.transactionLines) return state.transactionLines;
  if (table === schema.ledgerEntries) return state.ledgerEntries;
  if (table === schema.paymentApplications) return state.paymentApplications;
  if (table === schema.syncLinks) return state.syncLinks;
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
    syncLinks: [],
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
                for: (strength: 'update') => typeof result;
              };
              result.limit = (n: number) => Promise.resolve(filtered.slice(0, n).map(cloneRow));
              result.orderBy = () => Promise.resolve(filtered.map(cloneRow));
              // No-op passthrough: this file's route-level tests never exercise concurrent
              // requests, so unlike `payments/service.test.ts` (which does, for 30021) this mock
              // doesn't need real row-lock emulation — it just needs `.for('update')` to not throw
              // `TypeError: ... .for is not a function` on `recordPayment`'s locked read.
              result.for = () => result;
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
                  for (const row of matched) {
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

async function createInvoice(app: ReturnType<typeof buildApp>, sid: string, total = 100) {
  const contactId = await createCustomer(app, sid);
  const res = await app.inject({
    method: 'POST',
    url: '/api/invoices',
    cookies: { __session: sid },
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
      cookies: { __session: sid },
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
      cookies: { __session: sid },
      payload: { amount: 40, txnDate: '2026-07-05' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
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
      cookies: { __session: sid },
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
      cookies: { __session: sid },
      payload: { amount: 100, txnDate: '2026-07-05' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
      payload: { amount: 10, txnDate: '2026-07-06' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 409 for paying a voided invoice', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);
    await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/void`,
      cookies: { __session: sid },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
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
      cookies: { __session: sid },
      payload: { amount: 0, txnDate: '2026-07-05' },
    });
    expect(zero.statusCode).toBe(400);

    const negative = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
      payload: { amount: -10, txnDate: '2026-07-05' },
    });
    expect(negative.statusCode).toBe(400);

    const badId = await app.inject({
      method: 'POST',
      url: '/api/invoices/not-a-uuid/payments',
      cookies: { __session: sid },
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
      cookies: { __session: sid },
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
      cookies: { __session: sid },
      payload: { amount: 40, txnDate: '2026-07-05' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
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
      cookies: { __session: sid },
      payload: { amount: 100, txnDate: '2026-07-05' },
    });
    const paymentId = payRes.json().payment.id as string;

    const voidRes = await app.inject({
      method: 'POST',
      url: `/api/payments/${paymentId}/void`,
      cookies: { __session: sid },
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
      cookies: { __session: sid },
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
      cookies: { __session: sid },
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

describe('DELETE /api/payments/:id (20009 — distinct from void)', () => {
  it('deletes a payment: application removed, invoice steps back down, then payment 404s', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);
    const payRes = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
      payload: { amount: 100, txnDate: '2026-07-05' },
    });
    const paymentId = payRes.json().payment.id as string;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/payments/${paymentId}`,
      cookies: { __session: sid },
    });
    expect(del.statusCode).toBe(200);
    const body = del.json();
    // Delete is orthogonal to status: the payment stays 'paid' (delete never introduces a new
    // status value), but it's now invisible on GET and the invoice steps back down.
    expect(body.payment.status).toBe('paid');
    expect(body.invoice.status).toBe('open');
    expect(body.invoice.balance).toBe('100.00');
    expect(
      state.paymentApplications.filter(
        (a: Record<string, unknown>) => a.paymentTxnId === paymentId,
      ),
    ).toHaveLength(0);
    expect(state.auditLogs.some((a) => a.action === 'delete' && a.localId === paymentId)).toBe(
      true,
    );

    const get = await app.inject({
      method: 'GET',
      url: `/api/payments/${paymentId}`,
      cookies: { __session: sid },
    });
    expect(get.statusCode).toBe(404);

    await app.close();
  });

  it('deleting an already-deleted payment is idempotent (200, no duplicate audit row)', async () => {
    const { app, state, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);
    const payRes = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
      payload: { amount: 100, txnDate: '2026-07-05' },
    });
    const paymentId = payRes.json().payment.id as string;

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/payments/${paymentId}`,
      cookies: { __session: sid },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/payments/${paymentId}`,
      cookies: { __session: sid },
    });
    expect(second.statusCode).toBe(200);

    expect(
      state.auditLogs.filter((a) => a.action === 'delete' && a.localId === paymentId),
    ).toHaveLength(1);

    await app.close();
  });

  it('a voided payment can still be deleted (delete is more terminal than void)', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);
    const invoiceId = await createInvoice(app, sid, 100);
    const payRes = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
      payload: { amount: 100, txnDate: '2026-07-05' },
    });
    const paymentId = payRes.json().payment.id as string;

    const voidRes = await app.inject({
      method: 'POST',
      url: `/api/payments/${paymentId}/void`,
      cookies: { __session: sid },
    });
    expect(voidRes.statusCode).toBe(200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/payments/${paymentId}`,
      cookies: { __session: sid },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().payment.status).toBe('void');

    const get = await app.inject({
      method: 'GET',
      url: `/api/payments/${paymentId}`,
      cookies: { __session: sid },
    });
    expect(get.statusCode).toBe(404);

    await app.close();
  });

  it('returns 404 for a non-existent payment', async () => {
    const { app, password } = await buildTestApp();
    const sid = await loginAsAdmin(app, password);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/payments/${randomUUID()}`,
      cookies: { __session: sid },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 401 without a session cookie', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/payments/${randomUUID()}`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
