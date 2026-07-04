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
  updateInvoice,
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

interface SqlChunk {
  queryChunks?: SqlChunk[];
  constructor: { name: string };
  value?: unknown;
  table?: unknown;
  name?: unknown;
}

// Depth-first walk collecting (Column, Param) pairs from an `eq`/`and`
// condition tree, mirroring the approach in routes/contacts.test.ts. Good
// enough since the invoices service only ever builds simple `eq` leaves
// joined by `and`.
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
  contacts: FakeContact[];
  accounts: FakeAccount[];
  transactions: FakeTransaction[];
  transactionLines: FakeTransactionLine[];
  ledgerEntries: FakeLedgerEntry[];
  auditLogs: FakeAudit[];
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

function createFakeDb(opts: { failAuditInsert?: boolean } = {}) {
  const state: State = {
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
          const list = Array.isArray(vals) ? vals : [vals];
          const created = list.map((v) => insertRow(state, table, v, opts));
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
          if (table === schema.transactionLines) {
            state.transactionLines = state.transactionLines.filter(
              (r) => !rowMatches(table, r as unknown as Record<string, unknown>, cond),
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
      const snapshot: State = {
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
