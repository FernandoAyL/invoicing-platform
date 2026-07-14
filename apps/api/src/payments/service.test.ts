import { randomUUID } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import * as schema from '../db/schema.ts';
import { createInvoice } from '../invoices/service.ts';
import {
  ChartNotSeededError,
  getPayment,
  InvalidAmountError,
  InvalidDepositAccountError,
  InvalidStateError,
  invoiceRowQuery,
  listPaymentsForInvoice,
  NotFoundError,
  OverpaymentError,
  recordPayment,
  type Tx,
  voidPayment,
} from './service.ts';

interface FakeContact {
  id: string;
  orgId: string;
  displayName: string;
  isCustomer: boolean;
  isVendor: boolean;
  isEmployee: boolean;
  isActive: boolean;
}

interface FakeAccount {
  id: string;
  orgId: string;
  code: string | null;
  name: string;
  type: string;
  subtype: string | null;
  isActive: boolean;
}

interface FakeTransaction {
  id: string;
  orgId: string;
  type: string;
  status: string;
  contactId: string | null;
  docNumber: string | null;
  txnDate: string;
  dueDate: string | null;
  currency: string;
  memo: string | null;
  subtotal: string;
  total: string;
  balance: string;
  version: number;
  createdBy: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeTransactionLine {
  id: string;
  orgId: string;
  transactionId: string;
  lineNumber: number;
  itemId: string | null;
  accountId: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeLedgerEntry {
  id: string;
  orgId: string;
  transactionId: string;
  accountId: string;
  contactId: string | null;
  entryDate: string;
  debit: string;
  credit: string;
  createdAt: Date;
}

interface FakePaymentApplication {
  id: string;
  orgId: string;
  paymentTxnId: string;
  invoiceTxnId: string;
  amount: string;
  createdAt: Date;
}

interface FakeAudit {
  id: string;
  orgId: string;
  entityType: string | null;
  localId: string | null;
  action: string;
  direction: string;
  outcome: string;
  detail: unknown;
  userId: string | null;
  createdAt: Date;
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
 * "is null" text fragment (`isNull`) — order-independent within that span. */
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
  [schema.contacts, buildColumnMap(schema.contacts)],
  [schema.accounts, buildColumnMap(schema.accounts)],
  [schema.transactions, buildColumnMap(schema.transactions)],
  [schema.transactionLines, buildColumnMap(schema.transactionLines)],
  [schema.ledgerEntries, buildColumnMap(schema.ledgerEntries)],
  [schema.paymentApplications, buildColumnMap(schema.paymentApplications)],
  [schema.syncLinks, buildColumnMap(schema.syncLinks)],
]);

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

// 30022: minimal shape — this file never seeds `sync_links` rows (no test here exercises a linked
// invoice), so `bumpLocalVersion`'s query (called unconditionally from `recomputeInvoice`) always
// matches zero rows here and is a no-op. It's registered purely so that query doesn't crash on an
// unmapped table; direct coverage of `bumpLocalVersion` itself lives in
// `qbo/sync-link-service.test.ts`, and the full linked-invoice integration is covered by
// `sync-engine.e2e.test.ts` scenario 5 (30022 §2.6).
interface FakeSyncLink {
  id: string;
  orgId: string;
  entityType: string;
  localId: string;
  localVersion: number | null;
}

interface State {
  contacts: FakeContact[];
  accounts: FakeAccount[];
  transactions: FakeTransaction[];
  transactionLines: FakeTransactionLine[];
  ledgerEntries: FakeLedgerEntry[];
  paymentApplications: FakePaymentApplication[];
  auditLogs: FakeAudit[];
  syncLinks: FakeSyncLink[];
  // Row-lock emulation for `.for('update')` — see `acquireRowLock` below. Not part of the
  // transactional snapshot/restore: locks reflect live in-flight contention, not committed data.
  locks: Map<string, Promise<void>>;
}

function rowsForTable(state: State, table: unknown): Record<string, unknown>[] {
  if (table === schema.contacts) return state.contacts as unknown as Record<string, unknown>[];
  if (table === schema.accounts) return state.accounts as unknown as Record<string, unknown>[];
  if (table === schema.transactions)
    return state.transactions as unknown as Record<string, unknown>[];
  if (table === schema.transactionLines)
    return state.transactionLines as unknown as Record<string, unknown>[];
  if (table === schema.ledgerEntries)
    return state.ledgerEntries as unknown as Record<string, unknown>[];
  if (table === schema.paymentApplications)
    return state.paymentApplications as unknown as Record<string, unknown>[];
  if (table === schema.syncLinks) return state.syncLinks as unknown as Record<string, unknown>[];
  throw new Error('fakeDb: unsupported select().from() table');
}

function tableTag(table: unknown): string {
  if (table === schema.contacts) return 'contacts';
  if (table === schema.accounts) return 'accounts';
  if (table === schema.transactions) return 'transactions';
  if (table === schema.transactionLines) return 'transactionLines';
  if (table === schema.ledgerEntries) return 'ledgerEntries';
  if (table === schema.paymentApplications) return 'paymentApplications';
  return 'unknown';
}

/**
 * Emulates Postgres's `SELECT ... FOR UPDATE`: blocks until any row the query would return is
 * free, then hands back a release function the caller must invoke once its "transaction" commits
 * or rolls back. This exists because this file's hand-rolled fake DB — unlike this repo's
 * pglite-backed `createTestDb()` harness — does NOT serialize concurrent `db.transaction()` calls
 * on its own (verified empirically while implementing 30021: two concurrent `recordPayment` calls
 * against this fake DB genuinely interleave and, pre-fix, both succeed and overpay). Without this,
 * a `.for('update')` call here would need to be a no-op and the concurrent-recordPayment test below
 * could never distinguish "fixed" from "unfixed" — it would just document the mock's limitation
 * rather than proving anything. With it, the test is a real, fast, deterministic regression check.
 */
async function acquireRowLock(state: State, key: string): Promise<() => void> {
  while (state.locks.has(key)) {
    await state.locks.get(key);
  }
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.locks.set(key, held);
  return () => {
    state.locks.delete(key);
    release();
  };
}

function insertRow(
  state: State,
  table: unknown,
  vals: Record<string, unknown>,
  opts: { failAuditInsert?: boolean },
): Record<string, unknown> {
  const now = new Date();
  if (table === schema.transactions) {
    const row: FakeTransaction = {
      id: randomUUID(),
      orgId: vals.orgId as string,
      type: vals.type as string,
      status: (vals.status as string) ?? 'draft',
      contactId: (vals.contactId as string | undefined) ?? null,
      docNumber: (vals.docNumber as string | undefined) ?? null,
      txnDate: vals.txnDate as string,
      dueDate: (vals.dueDate as string | undefined) ?? null,
      currency: (vals.currency as string | undefined) ?? 'USD',
      memo: (vals.memo as string | undefined) ?? null,
      subtotal: (vals.subtotal as string | undefined) ?? '0.00',
      total: (vals.total as string | undefined) ?? '0.00',
      balance: (vals.balance as string | undefined) ?? '0.00',
      version: (vals.version as number | undefined) ?? 0,
      createdBy: (vals.createdBy as string | undefined) ?? null,
      deletedAt: (vals.deletedAt as Date | undefined) ?? null,
      createdAt: now,
      updatedAt: now,
    };
    state.transactions.push(row);
    return row as unknown as Record<string, unknown>;
  }
  if (table === schema.transactionLines) {
    const row: FakeTransactionLine = {
      id: randomUUID(),
      orgId: vals.orgId as string,
      transactionId: vals.transactionId as string,
      lineNumber: vals.lineNumber as number,
      itemId: (vals.itemId as string | undefined) ?? null,
      accountId: vals.accountId as string,
      description: (vals.description as string | undefined) ?? null,
      quantity: (vals.quantity as string | undefined) ?? '1',
      unitPrice: (vals.unitPrice as string | undefined) ?? '0.00',
      amount: (vals.amount as string | undefined) ?? '0.00',
      createdAt: now,
      updatedAt: now,
    };
    state.transactionLines.push(row);
    return row as unknown as Record<string, unknown>;
  }
  if (table === schema.ledgerEntries) {
    const row: FakeLedgerEntry = {
      id: randomUUID(),
      orgId: vals.orgId as string,
      transactionId: vals.transactionId as string,
      accountId: vals.accountId as string,
      contactId: (vals.contactId as string | undefined) ?? null,
      entryDate: vals.entryDate as string,
      debit: (vals.debit as string | undefined) ?? '0.00',
      credit: (vals.credit as string | undefined) ?? '0.00',
      createdAt: now,
    };
    state.ledgerEntries.push(row);
    return row as unknown as Record<string, unknown>;
  }
  if (table === schema.paymentApplications) {
    const row: FakePaymentApplication = {
      id: randomUUID(),
      orgId: vals.orgId as string,
      paymentTxnId: vals.paymentTxnId as string,
      invoiceTxnId: vals.invoiceTxnId as string,
      amount: vals.amount as string,
      createdAt: now,
    };
    state.paymentApplications.push(row);
    return row as unknown as Record<string, unknown>;
  }
  if (table === schema.syncAuditLogs) {
    if (opts.failAuditInsert) {
      throw new Error('simulated audit write failure');
    }
    const row: FakeAudit = {
      id: randomUUID(),
      orgId: vals.orgId as string,
      entityType: (vals.entityType as string | undefined) ?? null,
      localId: (vals.localId as string | undefined) ?? null,
      action: vals.action as string,
      direction: (vals.direction as string | undefined) ?? 'local',
      outcome: (vals.outcome as string | undefined) ?? 'success',
      detail: vals.detail ?? null,
      userId: (vals.userId as string | undefined) ?? null,
      createdAt: now,
    };
    state.auditLogs.push(row);
    return row as unknown as Record<string, unknown>;
  }
  throw new Error('fakeDb: unsupported insert().values() table');
}

// Mirrors `rowsForTable` but also covers `syncAuditLogs`, which `insertRow` writes to but selects
// never target — needed so insert-undo (below) can locate/remove a just-inserted audit row too.
function arrayForTable(state: State, table: unknown): Record<string, unknown>[] {
  if (table === schema.syncAuditLogs)
    return state.auditLogs as unknown as Record<string, unknown>[];
  return rowsForTable(state, table);
}

// `releases` collects lock-release callbacks acquired by `.for('update')` calls made through this
// particular API instance; `undoLog` collects per-row undo callbacks for every insert/update/delete
// made through it. `transaction()` below gives each concurrent call its own instance + arrays, and
// on failure replays *only that transaction's own* undo log (in reverse) rather than restoring a
// whole-array snapshot — a whole-array snapshot would incorrectly wipe out any other transaction's
// writes that committed concurrently while this one was blocked on a lock (exactly the interleaving
// this file's concurrent-recordPayment tests now exercise).
function makeDbApi(
  state: State,
  opts: { failAuditInsert?: boolean },
  releases: Array<() => void>,
  undoLog: Array<() => void>,
) {
  return {
    select() {
      return {
        from(table: unknown) {
          const rows = rowsForTable(state, table);
          return {
            where(cond?: unknown) {
              const filtered = cond ? rows.filter((r) => rowMatches(table, r, cond)) : rows.slice();
              const result = Promise.resolve(filtered.map(cloneRow)) as Promise<
                Record<string, unknown>[]
              > & {
                limit: (n: number) => Promise<Record<string, unknown>[]>;
                orderBy: () => Promise<Record<string, unknown>[]>;
                for: (strength: 'update') => {
                  limit: (n: number) => Promise<Record<string, unknown>[]>;
                };
              };
              result.limit = (n: number) => Promise.resolve(filtered.slice(0, n).map(cloneRow));
              result.orderBy = () => Promise.resolve(filtered.map(cloneRow));
              // Acquires a lock per matched row, blocking until free, then re-reads the row's
              // current (post-lock) state — mirroring real Postgres's lock-then-reread semantics.
              result.for = () => ({
                limit: async (n: number) => {
                  const ids = filtered.map((r) => (r as { id: string }).id);
                  for (const id of ids) {
                    releases.push(await acquireRowLock(state, `${tableTag(table)}:${id}`));
                  }
                  const fresh = (
                    cond ? rows.filter((r) => rowMatches(table, r, cond)) : rows.slice()
                  ).map(cloneRow);
                  return fresh.slice(0, n);
                },
              });
              return result;
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(vals: Record<string, unknown> | Record<string, unknown>[]) {
          const list = Array.isArray(vals) ? vals : [vals];
          const created = list.map((v) => insertRow(state, table, v, opts));
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
          if (table === schema.paymentApplications) {
            const removed = state.paymentApplications.filter((r) =>
              rowMatches(table, r as unknown as Record<string, unknown>, cond),
            );
            state.paymentApplications = state.paymentApplications.filter(
              (r) => !rowMatches(table, r as unknown as Record<string, unknown>, cond),
            );
            undoLog.push(() => {
              state.paymentApplications.push(...removed);
            });
          } else if (table === schema.transactionLines) {
            const removed = state.transactionLines.filter((r) =>
              rowMatches(table, r as unknown as Record<string, unknown>, cond),
            );
            state.transactionLines = state.transactionLines.filter(
              (r) => !rowMatches(table, r as unknown as Record<string, unknown>, cond),
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

function createFakeDb(opts: { failAuditInsert?: boolean; state?: State } = {}) {
  const state: State = opts.state ?? {
    contacts: [],
    accounts: [],
    transactions: [],
    transactionLines: [],
    ledgerEntries: [],
    paymentApplications: [],
    auditLogs: [],
    syncLinks: [],
    locks: new Map(),
  };

  const baseDb = makeDbApi(state, opts, [], []);

  const db = {
    ...baseDb,
    async transaction<T>(fn: (tx: ReturnType<typeof makeDbApi>) => Promise<T>): Promise<T> {
      const releases: Array<() => void> = [];
      const undoLog: Array<() => void> = [];
      const tx = makeDbApi(state, opts, releases, undoLog);
      try {
        return await fn(tx);
      } catch (err) {
        for (let i = undoLog.length - 1; i >= 0; i--) undoLog[i]();
        throw err;
      } finally {
        for (const release of releases) release();
      }
    },
  };

  return { db: db as unknown as NodePgDatabase<typeof schema>, state };
}

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const USER_ID = 'user-1';

function seedChartOfAccounts(state: ReturnType<typeof createFakeDb>['state'], orgId: string) {
  const ar: FakeAccount = {
    id: randomUUID(),
    orgId,
    code: '1200',
    name: 'Accounts Receivable',
    type: 'asset',
    subtype: 'accounts_receivable',
    isActive: true,
  };
  const salesIncome: FakeAccount = {
    id: randomUUID(),
    orgId,
    code: '4000',
    name: 'Sales Income',
    type: 'income',
    subtype: 'sales_income',
    isActive: true,
  };
  const undepositedFunds: FakeAccount = {
    id: randomUUID(),
    orgId,
    code: '1499',
    name: 'Undeposited Funds',
    type: 'asset',
    subtype: 'undeposited_funds',
    isActive: true,
  };
  const bank: FakeAccount = {
    id: randomUUID(),
    orgId,
    code: '1000',
    name: 'Business Checking',
    type: 'asset',
    subtype: 'bank',
    isActive: true,
  };
  state.accounts.push(ar, salesIncome, undepositedFunds, bank);
  return { ar, salesIncome, undepositedFunds, bank };
}

function seedCustomer(state: ReturnType<typeof createFakeDb>['state'], orgId: string) {
  const contact: FakeContact = {
    id: randomUUID(),
    orgId,
    displayName: 'Acme Co',
    isCustomer: true,
    isVendor: false,
    isEmployee: false,
    isActive: true,
  };
  state.contacts.push(contact);
  return contact;
}

function netForAccount(entries: FakeLedgerEntry[], accountId: string): number {
  return entries
    .filter((e) => e.accountId === accountId)
    .reduce((sum, e) => sum + (Number(e.debit) - Number(e.credit)) * 100, 0);
}

async function createBaseInvoice(
  db: NodePgDatabase<typeof schema>,
  customerId: string,
  totalDollars = 100,
) {
  return createInvoice(
    db,
    { orgId: ORG_A, userId: USER_ID },
    {
      contactId: customerId,
      txnDate: '2026-07-04',
      lines: [{ quantity: 1, unitPrice: totalDollars }],
    },
  );
}

describe('invoiceRowQuery', () => {
  // Connectionless query-builder db — `.toSQL()` works with zero network/DB access, so this
  // proves the generated SQL shape without needing pglite or a live Postgres.
  it('adds FOR UPDATE to the generated SQL when forUpdate is true', () => {
    const mockDb = drizzle.mock({ schema });
    const { sql } = invoiceRowQuery(mockDb as unknown as Tx, 'org-1', 'invoice-1', {
      forUpdate: true,
    }).toSQL();
    expect(sql.toLowerCase()).toContain('for update');
  });

  it('omits FOR UPDATE by default', () => {
    const mockDb = drizzle.mock({ schema });
    const { sql } = invoiceRowQuery(mockDb as unknown as Tx, 'org-1', 'invoice-1').toSQL();
    expect(sql.toLowerCase()).not.toContain('for update');
  });

  it('keeps the same WHERE condition shape with and without the lock', () => {
    const mockDb = drizzle.mock({ schema });
    const unlocked = invoiceRowQuery(mockDb as unknown as Tx, 'org-1', 'invoice-1').toSQL();
    const locked = invoiceRowQuery(mockDb as unknown as Tx, 'org-1', 'invoice-1', {
      forUpdate: true,
    }).toSQL();
    expect(locked.params).toEqual(unlocked.params);
    expect(locked.sql.replace(/\s*for update\s*$/i, '')).toBe(unlocked.sql);
  });
});

// These two tests genuinely exercise `FOR UPDATE` row-lock contention via `acquireRowLock` (see
// its doc comment above) rather than merely proving "correct when forced to run sequentially."
// Confirmed by temporarily reverting `recordPayment`'s `{ forUpdate: true }` to `false` while
// writing this: the first test above fails (both calls succeed, invoice overpaid to $120/$100)
// without the fix, and passes with it — so this is a real regression check, not a no-op. The fake
// DB's lock emulation is still a hand-rolled simulation, not the real Postgres lock manager; the
// one-time manual check against a real local Postgres (see the plan/PR notes) is the check that
// isn't undermined by any mock's limitations.
describe('recordPayment concurrency (30021)', () => {
  it('serializes two concurrent recordPayment calls that together would overpay: exactly one succeeds', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id, 100);

    const [first, second] = await Promise.allSettled([
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 60,
        txnDate: '2026-07-01',
      }),
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 60,
        txnDate: '2026-07-01',
      }),
    ]);

    const outcomes = [first, second];
    const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
    const rejected = outcomes.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OverpaymentError);

    // Exactly one payment landed — the invoice reflects only the one that actually committed.
    expect(state.paymentApplications).toHaveLength(1);
    expect(state.transactions.filter((t) => t.type === 'payment')).toHaveLength(1);
    const invoiceRow = state.transactions.find((t) => t.id === invoice.id);
    expect(invoiceRow?.balance).toBe('40.00');
    expect(invoiceRow?.status).toBe('partially_paid');
  });

  it('allows two concurrent recordPayment calls that together do not overpay: both succeed, balance reflects both', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id, 100);

    const [first, second] = await Promise.all([
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 30,
        txnDate: '2026-07-01',
      }),
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 30,
        txnDate: '2026-07-01',
      }),
    ]);

    expect(first.payment.total).toBe('30.00');
    expect(second.payment.total).toBe('30.00');
    expect(state.paymentApplications).toHaveLength(2);
    const invoiceRow = state.transactions.find((t) => t.id === invoice.id);
    // Neither payment's view of `alreadyPaidCents` was stale — the second to acquire the lock
    // saw the first's committed application, so the invoice reflects both, not a lost update.
    expect(invoiceRow?.balance).toBe('40.00');
    expect(invoiceRow?.status).toBe('partially_paid');
  });
});

describe('recordPayment', () => {
  it('records a partial payment: debits undeposited funds / credits A/R, invoice -> partially_paid', async () => {
    const { db, state } = createFakeDb();
    const { ar, undepositedFunds } = seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    const result = await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 40,
      txnDate: '2026-07-05',
    });

    expect(result.invoice.status).toBe('partially_paid');
    expect(result.invoice.balance).toBe('60.00');
    expect(result.payment.total).toBe('40.00');
    expect(result.payment.status).toBe('paid');

    expect(state.paymentApplications).toHaveLength(1);
    expect(state.paymentApplications[0]).toMatchObject({
      invoiceTxnId: invoice.id,
      paymentTxnId: result.payment.id,
      amount: '40.00',
    });

    const paymentLedger = state.ledgerEntries.filter((e) => e.transactionId === result.payment.id);
    expect(paymentLedger).toHaveLength(2);
    expect(netForAccount(paymentLedger, undepositedFunds.id)).toBe(4000);
    expect(netForAccount(paymentLedger, ar.id)).toBe(-4000);

    const paymentAudits = state.auditLogs.filter((a) => a.action === 'payment');
    expect(paymentAudits).toHaveLength(1);
    expect(paymentAudits[0]).toMatchObject({ localId: result.payment.id, orgId: ORG_A });
  });

  it('fully pays a partially-paid invoice, moving it to paid with 0 balance', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 40,
      txnDate: '2026-07-05',
    });
    const result = await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 60,
      txnDate: '2026-07-06',
    });

    expect(result.invoice.status).toBe('paid');
    expect(result.invoice.balance).toBe('0.00');
    expect(state.paymentApplications).toHaveLength(2);
  });

  it('rejects overpayment with OverpaymentError (422), nothing written', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    await expect(
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 120,
        txnDate: '2026-07-05',
      }),
    ).rejects.toThrow(OverpaymentError);

    expect(state.paymentApplications).toHaveLength(0);
    expect(state.ledgerEntries).toHaveLength(2); // only the original invoice posting
    expect(state.transactions.filter((t) => t.type === 'payment')).toHaveLength(0);
  });

  it('rejects overpayment on the remaining balance after a partial payment', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 60,
      txnDate: '2026-07-05',
    });

    await expect(
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 41,
        txnDate: '2026-07-06',
      }),
    ).rejects.toThrow(OverpaymentError);
    expect(state.paymentApplications).toHaveLength(1);
  });

  it('rejects a zero/negative amount with InvalidAmountError (400)', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    await expect(
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 0,
        txnDate: '2026-07-05',
      }),
    ).rejects.toThrow(InvalidAmountError);
    expect(state.paymentApplications).toHaveLength(0);
  });

  it('rejects an amount with more than 2 decimal places with InvalidAmountError (400)', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    await expect(
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 4.995,
        txnDate: '2026-07-05',
      }),
    ).rejects.toThrow(InvalidAmountError);
    expect(state.paymentApplications).toHaveLength(0);
  });

  it('rejects paying a fully paid invoice with InvalidStateError (409)', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);
    await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 100,
      txnDate: '2026-07-05',
    });

    await expect(
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 10,
        txnDate: '2026-07-06',
      }),
    ).rejects.toThrow(InvalidStateError);
    expect(state.paymentApplications).toHaveLength(1);
  });

  it('rejects paying a voided invoice with InvalidStateError (409)', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);
    const invoiceRow = state.transactions.find((t) => t.id === invoice.id);
    if (!invoiceRow) throw new Error('invoice row missing in test setup');
    invoiceRow.status = 'void';

    await expect(
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 10,
        txnDate: '2026-07-06',
      }),
    ).rejects.toThrow(InvalidStateError);
  });

  it('throws NotFoundError for a cross-org invoice', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    seedChartOfAccounts(state, ORG_B);
    const customer = seedCustomer(state, ORG_B);
    const invoice = await createInvoice(
      db,
      { orgId: ORG_B, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 10 }] },
    );

    await expect(
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 5,
        txnDate: '2026-07-05',
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('uses an explicit asset deposit account instead of undeposited funds', async () => {
    const { db, state } = createFakeDb();
    const { bank, ar } = seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    const result = await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 25,
      txnDate: '2026-07-05',
      depositAccountId: bank.id,
    });

    const paymentLedger = state.ledgerEntries.filter((e) => e.transactionId === result.payment.id);
    expect(netForAccount(paymentLedger, bank.id)).toBe(2500);
    expect(netForAccount(paymentLedger, ar.id)).toBe(-2500);
  });

  it('rejects a non-asset explicit deposit account with InvalidDepositAccountError (422)', async () => {
    const { db, state } = createFakeDb();
    const { salesIncome } = seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    await expect(
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 25,
        txnDate: '2026-07-05',
        depositAccountId: salesIncome.id,
      }),
    ).rejects.toThrow(InvalidDepositAccountError);
    expect(state.paymentApplications).toHaveLength(0);
  });

  it('throws NotFoundError for a cross-org deposit account id', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const { bank: otherOrgBank } = seedChartOfAccounts(state, ORG_B);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    await expect(
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 25,
        txnDate: '2026-07-05',
        depositAccountId: otherOrgBank.id,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws ChartNotSeededError when undeposited_funds is not seeded', async () => {
    const { db, state } = createFakeDb();
    const ar: FakeAccount = {
      id: randomUUID(),
      orgId: ORG_A,
      code: '1200',
      name: 'Accounts Receivable',
      type: 'asset',
      subtype: 'accounts_receivable',
      isActive: true,
    };
    const salesIncome: FakeAccount = {
      id: randomUUID(),
      orgId: ORG_A,
      code: '4000',
      name: 'Sales Income',
      type: 'income',
      subtype: 'sales_income',
      isActive: true,
    };
    state.accounts.push(ar, salesIncome);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    await expect(
      recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 25,
        txnDate: '2026-07-05',
      }),
    ).rejects.toThrow(ChartNotSeededError);
  });

  it('rolls back payment + application + ledger + invoice update if the audit write fails', async () => {
    // The invoice (and its own audit row) is created first on a db with
    // audit-writing enabled; a second db handle bound to the same state
    // then arms failAuditInsert for the payment call itself.
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    const { db: failingDb } = createFakeDb({ failAuditInsert: true, state });

    await expect(
      recordPayment(failingDb, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        amount: 40,
        txnDate: '2026-07-05',
      }),
    ).rejects.toThrow('simulated audit write failure');

    expect(state.paymentApplications).toHaveLength(0);
    expect(state.transactions.filter((t) => t.type === 'payment')).toHaveLength(0);
    expect(state.ledgerEntries).toHaveLength(2); // only the invoice's own posting, unaffected
  });
});

describe('voidPayment', () => {
  it('reverses the ledger to net zero, removes the application, and steps the invoice back down', async () => {
    const { db, state } = createFakeDb();
    const { ar, undepositedFunds } = seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 40,
      txnDate: '2026-07-05',
    });
    const full = await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 60,
      txnDate: '2026-07-06',
    });
    expect(full.invoice.status).toBe('paid');

    const result = await voidPayment(db, { orgId: ORG_A, userId: USER_ID }, full.payment.id);

    expect(result.payment.status).toBe('void');
    expect(result.invoice.status).toBe('partially_paid');
    expect(result.invoice.balance).toBe('60.00');

    const voidedLedger = state.ledgerEntries.filter((e) => e.transactionId === full.payment.id);
    expect(netForAccount(voidedLedger, undepositedFunds.id)).toBe(0);
    expect(netForAccount(voidedLedger, ar.id)).toBe(0);
    // Ledger rows are retained (append-only), not deleted.
    expect(voidedLedger.length).toBeGreaterThan(2);

    expect(state.paymentApplications.some((a) => a.paymentTxnId === full.payment.id)).toBe(false);

    const voidAudits = state.auditLogs.filter((a) => a.action === 'void');
    expect(voidAudits).toHaveLength(1);
  });

  it('steps a fully-paid invoice back to open when its only payment is voided', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);
    const payment = await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 100,
      txnDate: '2026-07-05',
    });

    const result = await voidPayment(db, { orgId: ORG_A, userId: USER_ID }, payment.payment.id);
    expect(result.invoice.status).toBe('open');
    expect(result.invoice.balance).toBe('100.00');
    expect(state.paymentApplications).toHaveLength(0);
  });

  it('rejects double-voiding a payment with InvalidStateError (409)', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);
    const payment = await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 40,
      txnDate: '2026-07-05',
    });
    await voidPayment(db, { orgId: ORG_A, userId: USER_ID }, payment.payment.id);
    const ledgerCountAfterFirstVoid = state.ledgerEntries.length;

    await expect(
      voidPayment(db, { orgId: ORG_A, userId: USER_ID }, payment.payment.id),
    ).rejects.toThrow(InvalidStateError);
    expect(state.ledgerEntries).toHaveLength(ledgerCountAfterFirstVoid);
  });

  it('throws NotFoundError for a cross-org payment id', async () => {
    const { db: dbA, state: stateA } = createFakeDb();
    seedChartOfAccounts(stateA, ORG_A);
    const customerA = seedCustomer(stateA, ORG_A);
    const invoiceA = await createBaseInvoice(dbA, customerA.id);
    const payment = await recordPayment(dbA, { orgId: ORG_A, userId: USER_ID }, invoiceA.id, {
      amount: 40,
      txnDate: '2026-07-05',
    });

    await expect(
      voidPayment(dbA, { orgId: ORG_B, userId: USER_ID }, payment.payment.id),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('listPaymentsForInvoice / getPayment', () => {
  it('lists payments applied to an invoice, scoped to the org', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);
    const first = await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 40,
      txnDate: '2026-07-05',
    });
    const second = await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 60,
      txnDate: '2026-07-06',
    });

    const list = await listPaymentsForInvoice(db, ORG_A, invoice.id);
    expect(list.map((p) => p.id).sort()).toEqual([first.payment.id, second.payment.id].sort());

    const cross = await listPaymentsForInvoice(db, ORG_B, invoice.id).catch((e) => e);
    expect(cross).toBeInstanceOf(NotFoundError);
  });

  it('gets a single payment by id, scoped to the org, null across orgs', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);
    const payment = await recordPayment(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      amount: 40,
      txnDate: '2026-07-05',
    });

    const found = await getPayment(db, ORG_A, payment.payment.id);
    expect(found?.id).toBe(payment.payment.id);

    const notFound = await getPayment(db, ORG_B, payment.payment.id);
    expect(notFound).toBeNull();
  });
});
