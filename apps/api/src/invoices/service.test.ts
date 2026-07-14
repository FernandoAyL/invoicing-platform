import { randomUUID } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema.ts';
import {
  ChartNotSeededError,
  createInvoice,
  getInvoice,
  InvalidContactError,
  InvalidLineError,
  InvalidStateError,
  listInvoices,
  type SyncState,
  updateInvoice,
  VersionConflictError,
  voidInvoice,
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

interface FakeSyncLink {
  id: string;
  orgId: string;
  entityType: string;
  localId: string;
  state: SyncState;
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
// positional columns[]/params[] zip. See `extractFieldConditions` below. Good enough since the
// invoices service only ever builds simple `eq`/`isNull` leaves joined by `and`.
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

interface State {
  contacts: FakeContact[];
  accounts: FakeAccount[];
  transactions: FakeTransaction[];
  transactionLines: FakeTransactionLine[];
  ledgerEntries: FakeLedgerEntry[];
  auditLogs: FakeAudit[];
  syncLinks: FakeSyncLink[];
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
  throw new Error('fakeDb: unsupported select().from() table');
}

// Mirrors `rowsForTable` but also covers `syncAuditLogs`, which `insertRow` writes to but selects
// never target — needed so insert-undo (below) can locate/remove a just-inserted audit row too.
function arrayForTable(state: State, table: unknown): Record<string, unknown>[] {
  if (table === schema.syncAuditLogs)
    return state.auditLogs as unknown as Record<string, unknown>[];
  return rowsForTable(state, table);
}

// 30022/30024: per-transaction undo log, replacing a former whole-array snapshot/restore. A
// whole-array restore would incorrectly wipe out another transaction's writes that committed
// concurrently while this one was still in flight — exactly the interleaving the new concurrent
// updateInvoice/voidInvoice tests below exercise (mirrors the fix payments/service.test.ts already
// needed for 30021's concurrent-recordPayment tests). Each `db.transaction()` call gets its own
// `undoLog` array; on failure only that transaction's own writes are unwound, in reverse order.
function makeDbApi(state: State, opts: { failAuditInsert?: boolean }, undoLog: Array<() => void>) {
  return {
    select() {
      return {
        from(table: unknown) {
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

          // Only the invoices service's syncState join needs emulation here
          // (transactions LEFT JOIN sync_links). Other `.from(transactions)`
          // callers never call `.leftJoin` and keep using `whereChain()`
          // above unaffected.
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
                      return { txn: cloneRow(txnRow), syncState: link ? link.state : 'pending' };
                    });
                    const result = Promise.resolve(joined) as Promise<
                      { txn: Record<string, unknown>; syncState: SyncState }[]
                    > & {
                      limit: (
                        n: number,
                      ) => Promise<{ txn: Record<string, unknown>; syncState: SyncState }[]>;
                      orderBy: () => Promise<
                        { txn: Record<string, unknown>; syncState: SyncState }[]
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
          if (table === schema.transactionLines) {
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

function createFakeDb(opts: { failAuditInsert?: boolean } = {}) {
  const state: State = {
    contacts: [],
    accounts: [],
    transactions: [],
    transactionLines: [],
    ledgerEntries: [],
    auditLogs: [],
    syncLinks: [],
  };

  const baseDb = makeDbApi(state, opts, []);

  const db = {
    ...baseDb,
    async transaction<T>(fn: (tx: ReturnType<typeof makeDbApi>) => Promise<T>): Promise<T> {
      const undoLog: Array<() => void> = [];
      const tx = makeDbApi(state, opts, undoLog);
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
  state.accounts.push(ar, salesIncome);
  return { ar, salesIncome };
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

describe('createInvoice', () => {
  it('creates an open invoice with a balanced debit A/R / credit income posting', async () => {
    const { db, state } = createFakeDb();
    const { ar, salesIncome } = seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);

    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      {
        contactId: customer.id,
        txnDate: '2026-07-04',
        lines: [{ quantity: 1, unitPrice: 100 }],
      },
    );

    expect(invoice.status).toBe('open');
    expect(invoice.total).toBe('100.00');
    expect(invoice.balance).toBe('100.00');
    expect(invoice.version).toBe(0);
    expect(invoice.lines).toHaveLength(1);

    expect(state.transactions).toHaveLength(1);
    expect(state.transactionLines).toHaveLength(1);
    expect(state.ledgerEntries).toHaveLength(2);

    const arNet = netForAccount(state.ledgerEntries, ar.id);
    const incomeNet = netForAccount(state.ledgerEntries, salesIncome.id);
    expect(arNet).toBe(10000);
    expect(incomeNet).toBe(-10000);

    const createAudits = state.auditLogs.filter((a) => a.action === 'create');
    expect(createAudits).toHaveLength(1);
    expect(createAudits[0]).toMatchObject({
      orgId: ORG_A,
      entityType: 'transaction',
      localId: invoice.id,
      userId: USER_ID,
    });
  });

  it('handles multi-line invoices and ties out fractional quantities without float drift', async () => {
    const { db, state } = createFakeDb();
    const { ar, salesIncome } = seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);

    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      {
        contactId: customer.id,
        txnDate: '2026-07-04',
        lines: [
          { quantity: 1.5, unitPrice: 10 },
          { quantity: 1, unitPrice: 0.1 },
          { quantity: 1, unitPrice: 0.2 },
        ],
      },
    );

    // 1.5*10.00 + 0.10 + 0.20 = 15.30, computed as exact integer cents.
    expect(invoice.total).toBe('15.30');
    const arNet = netForAccount(state.ledgerEntries, ar.id);
    const incomeNet = netForAccount(state.ledgerEntries, salesIncome.id);
    expect(arNet).toBe(1530);
    expect(incomeNet).toBe(-1530);
  });

  it('rejects a unit price with more than 2 decimal places (400-mapped InvalidLineError)', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);

    await expect(
      createInvoice(
        db,
        { orgId: ORG_A, userId: USER_ID },
        {
          contactId: customer.id,
          txnDate: '2026-07-04',
          lines: [{ quantity: 2, unitPrice: 4.995 }],
        },
      ),
    ).rejects.toThrow(InvalidLineError);

    expect(state.transactions).toHaveLength(0);
    expect(state.ledgerEntries).toHaveLength(0);
  });

  it('rejects a non-customer contact with InvalidContactError (422)', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const vendor: FakeContact = {
      id: randomUUID(),
      orgId: ORG_A,
      displayName: 'Vendor Co',
      isCustomer: false,
      isVendor: true,
      isEmployee: false,
      isActive: true,
    };
    state.contacts.push(vendor);

    await expect(
      createInvoice(
        db,
        { orgId: ORG_A, userId: USER_ID },
        { contactId: vendor.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 10 }] },
      ),
    ).rejects.toThrow(InvalidContactError);
  });

  it('rejects a contact belonging to another org with InvalidContactError', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const otherOrgCustomer = seedCustomer(state, ORG_B);

    await expect(
      createInvoice(
        db,
        { orgId: ORG_A, userId: USER_ID },
        {
          contactId: otherOrgCustomer.id,
          txnDate: '2026-07-04',
          lines: [{ quantity: 1, unitPrice: 10 }],
        },
      ),
    ).rejects.toThrow(InvalidContactError);
  });

  it('throws ChartNotSeededError (409) when the org has no seeded accounts', async () => {
    const { db, state } = createFakeDb();
    const customer = seedCustomer(state, ORG_A);

    await expect(
      createInvoice(
        db,
        { orgId: ORG_A, userId: USER_ID },
        { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 10 }] },
      ),
    ).rejects.toThrow(ChartNotSeededError);
  });

  it('rolls back the transaction, lines, and ledger if the audit write fails', async () => {
    const { db, state } = createFakeDb({ failAuditInsert: true });
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);

    await expect(
      createInvoice(
        db,
        { orgId: ORG_A, userId: USER_ID },
        { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 10 }] },
      ),
    ).rejects.toThrow('simulated audit write failure');

    expect(state.transactions).toHaveLength(0);
    expect(state.transactionLines).toHaveLength(0);
    expect(state.ledgerEntries).toHaveLength(0);
  });
});

describe('updateInvoice', () => {
  async function createBaseInvoice(db: NodePgDatabase<typeof schema>, customerId: string) {
    return createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customerId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    );
  }

  it('recomputes totals, bumps version, and nets the ledger to the new total (old rows kept)', async () => {
    const { db, state } = createFakeDb();
    const { ar, salesIncome } = seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    const updated = await updateInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      lines: [{ quantity: 1, unitPrice: 150 }],
    });

    expect(updated.total).toBe('150.00');
    expect(updated.balance).toBe('150.00');
    expect(updated.version).toBe(1);
    expect(updated.lines).toHaveLength(1);
    expect(updated.lines[0]?.unitPrice).toBe('150.00');

    // Immutable ledger: nothing was deleted or mutated, but the net per
    // account across all rows for this transaction reflects the new total.
    expect(state.ledgerEntries.length).toBeGreaterThan(2);
    const arNet = netForAccount(state.ledgerEntries, ar.id);
    const incomeNet = netForAccount(state.ledgerEntries, salesIncome.id);
    expect(arNet).toBe(15000);
    expect(incomeNet).toBe(-15000);

    const updateAudits = state.auditLogs.filter((a) => a.action === 'update');
    expect(updateAudits).toHaveLength(1);
  });

  it('leaves lines untouched and still re-ties the ledger when only a header field changes', async () => {
    const { db, state } = createFakeDb();
    const { ar, salesIncome } = seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);

    const updated = await updateInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
      memo: 'net 30',
    });

    expect(updated.memo).toBe('net 30');
    expect(updated.total).toBe('100.00');
    expect(updated.version).toBe(1);
    expect(netForAccount(state.ledgerEntries, ar.id)).toBe(10000);
    expect(netForAccount(state.ledgerEntries, salesIncome.id)).toBe(-10000);
  });

  it('rejects editing a voided invoice with InvalidStateError (409)', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createBaseInvoice(db, customer.id);
    await voidInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id);

    await expect(
      updateInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        lines: [{ quantity: 1, unitPrice: 200 }],
      }),
    ).rejects.toThrow(InvalidStateError);
  });
});

describe('voidInvoice', () => {
  it('nets the ledger to zero, sets status void and balance 0, and keeps the record', async () => {
    const { db, state } = createFakeDb();
    const { ar, salesIncome } = seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    );

    const voided = await voidInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id);

    expect(voided.status).toBe('void');
    expect(voided.balance).toBe('0.00');
    expect(voided.version).toBe(1);
    expect(state.transactions).toHaveLength(1);
    expect(netForAccount(state.ledgerEntries, ar.id)).toBe(0);
    expect(netForAccount(state.ledgerEntries, salesIncome.id)).toBe(0);

    const voidAudits = state.auditLogs.filter((a) => a.action === 'void');
    expect(voidAudits).toHaveLength(1);
  });

  it('rejects voiding an already-voided invoice with InvalidStateError (409), idempotent no-op ledger', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    );
    await voidInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id);
    const ledgerCountAfterFirstVoid = state.ledgerEntries.length;

    await expect(voidInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id)).rejects.toThrow(
      InvalidStateError,
    );

    // Rejected before any re-posting attempt; ledger untouched.
    expect(state.ledgerEntries).toHaveLength(ledgerCountAfterFirstVoid);
  });
});

// 30022/30024: these three tests genuinely exercise the optimistic `WHERE version = <read
// version>` compare-and-swap via real interleaving on this fake DB (no lock needed — unlike
// 30021's pessimistic FOR UPDATE tests, an optimistic conditional write is correct under
// interleaving with no blocking required). Confirmed empirically while writing these: temporarily
// reverting `updateInvoice`/`voidInvoice`'s `.where` to drop `eq(transactions.version,
// existing.version)` makes the first test below fail (both calls succeed, one silently overwrites
// the other's patch, `version` only ever advances to 1 despite two real edits landing) — restored
// after confirming, see the developer report.
describe('concurrent version bump (30022/30024)', () => {
  it('two concurrent updateInvoice calls with different patches: exactly one succeeds, the loser gets VersionConflictError, final state reflects only the winner', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    );

    const [first, second] = await Promise.allSettled([
      updateInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        memo: 'edit A',
        lines: [{ quantity: 1, unitPrice: 150 }],
      }),
      updateInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, {
        memo: 'edit B',
        lines: [{ quantity: 1, unitPrice: 200 }],
      }),
    ]);

    const outcomes = [first, second];
    const fulfilled = outcomes.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof updateInvoice>>> =>
        r.status === 'fulfilled',
    );
    const rejected = outcomes.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);

    // Exactly one increment landed - not a lost update (dropped to a stale value) and not a
    // double-increment (both applied on top of each other).
    const winner = fulfilled[0]?.value;
    expect(winner?.version).toBe(1);
    const finalRow = state.transactions.find((t) => t.id === invoice.id);
    expect(finalRow?.version).toBe(1);
    // Persisted state matches only the winner's patch - not a merge of both edits.
    expect(finalRow?.memo).toBe(winner?.memo);
    expect(finalRow?.total).toBe(winner?.total);
  });

  it('two concurrent voidInvoice calls on the same invoice: exactly one succeeds, the loser gets VersionConflictError', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    );

    const [first, second] = await Promise.allSettled([
      voidInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id),
      voidInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id),
    ]);

    const outcomes = [first, second];
    const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
    const rejected = outcomes.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);

    const finalRow = state.transactions.find((t) => t.id === invoice.id);
    expect(finalRow?.status).toBe('void');
    expect(finalRow?.version).toBe(1);
  });

  it('updateInvoice racing voidInvoice on the same invoice: whichever commits first wins, the other gets VersionConflictError', async () => {
    const { db, state } = createFakeDb();
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    );

    const [updateResult, voidResult] = await Promise.allSettled([
      updateInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id, { memo: 'racing edit' }),
      voidInvoice(db, { orgId: ORG_A, userId: USER_ID }, invoice.id),
    ]);

    const outcomes = [updateResult, voidResult];
    const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
    const rejected = outcomes.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);

    const finalRow = state.transactions.find((t) => t.id === invoice.id);
    expect(finalRow?.version).toBe(1);
    if (updateResult.status === 'fulfilled') {
      expect(finalRow?.status).toBe('open');
      expect(finalRow?.memo).toBe('racing edit');
    } else {
      expect(finalRow?.status).toBe('void');
    }
  });
});

describe('getInvoice / listInvoices', () => {
  let db: NodePgDatabase<typeof schema>;
  let state: ReturnType<typeof createFakeDb>['state'];

  beforeEach(() => {
    ({ db, state } = createFakeDb());
  });

  it('returns null for a cross-org invoice id', async () => {
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 10 }] },
    );

    const result = await getInvoice(db, ORG_B, invoice.id);
    expect(result).toBeNull();
  });

  it('returns lines sorted by lineNumber', async () => {
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      {
        contactId: customer.id,
        txnDate: '2026-07-04',
        lines: [
          { quantity: 1, unitPrice: 10, description: 'first' },
          { quantity: 1, unitPrice: 20, description: 'second' },
        ],
      },
    );

    const fetched = await getInvoice(db, ORG_A, invoice.id);
    expect(fetched?.lines.map((l) => l.description)).toEqual(['first', 'second']);
  });

  it('filters by status', async () => {
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const open = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 10 }] },
    );
    const toVoid = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 20 }] },
    );
    await voidInvoice(db, { orgId: ORG_A, userId: USER_ID }, toVoid.id);

    const openOnly = await listInvoices(db, ORG_A, { status: 'open' });
    expect(openOnly.map((i) => i.id)).toEqual([open.id]);

    const voidOnly = await listInvoices(db, ORG_A, { status: 'void' });
    expect(voidOnly.map((i) => i.id)).toEqual([toVoid.id]);
  });
});

describe('syncState (sync_links LEFT JOIN)', () => {
  let db: NodePgDatabase<typeof schema>;
  let state: ReturnType<typeof createFakeDb>['state'];

  beforeEach(() => {
    ({ db, state } = createFakeDb());
  });

  it('reports "pending" for a freshly created invoice with no sync_links row', async () => {
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 10 }] },
    );

    const fetched = await getInvoice(db, ORG_A, invoice.id);
    expect(fetched?.syncState).toBe('pending');

    const [listed] = await listInvoices(db, ORG_A);
    expect(listed?.syncState).toBe('pending');
  });

  it('reflects a seeded sync_links state on both getInvoice and listInvoices', async () => {
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 10 }] },
    );
    state.syncLinks.push({
      id: randomUUID(),
      orgId: ORG_A,
      entityType: 'transaction',
      localId: invoice.id,
      state: 'synced',
    });

    const fetched = await getInvoice(db, ORG_A, invoice.id);
    expect(fetched?.syncState).toBe('synced');

    const [listed] = await listInvoices(db, ORG_A);
    expect(listed?.syncState).toBe('synced');
  });

  it('reflects "conflict" and "failed" sync_links states too', async () => {
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const conflicted = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 10 }] },
    );
    const failed = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 20 }] },
    );
    state.syncLinks.push(
      {
        id: randomUUID(),
        orgId: ORG_A,
        entityType: 'transaction',
        localId: conflicted.id,
        state: 'conflict',
      },
      {
        id: randomUUID(),
        orgId: ORG_A,
        entityType: 'transaction',
        localId: failed.id,
        state: 'failed',
      },
    );

    expect((await getInvoice(db, ORG_A, conflicted.id))?.syncState).toBe('conflict');
    expect((await getInvoice(db, ORG_A, failed.id))?.syncState).toBe('failed');
  });

  it('never leaks a cross-org sync_links row (same localId, different org)', async () => {
    seedChartOfAccounts(state, ORG_A);
    const customer = seedCustomer(state, ORG_A);
    const invoice = await createInvoice(
      db,
      { orgId: ORG_A, userId: USER_ID },
      { contactId: customer.id, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 10 }] },
    );
    // Seeded under ORG_B - must not be picked up when reading the ORG_A invoice.
    state.syncLinks.push({
      id: randomUUID(),
      orgId: ORG_B,
      entityType: 'transaction',
      localId: invoice.id,
      state: 'synced',
    });

    const fetched = await getInvoice(db, ORG_A, invoice.id);
    expect(fetched?.syncState).toBe('pending');

    const [listed] = await listInvoices(db, ORG_A);
    expect(listed?.syncState).toBe('pending');
  });
});
