import { randomUUID } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import * as schema from '../db/schema.ts';
import { createInvoice } from '../invoices/service.ts';
import {
  ChartNotSeededError,
  getPayment,
  InvalidAmountError,
  InvalidDepositAccountError,
  InvalidStateError,
  listPaymentsForInvoice,
  NotFoundError,
  OverpaymentError,
  recordPayment,
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
  contacts: FakeContact[];
  accounts: FakeAccount[];
  transactions: FakeTransaction[];
  transactionLines: FakeTransactionLine[];
  ledgerEntries: FakeLedgerEntry[];
  paymentApplications: FakePaymentApplication[];
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
  if (table === schema.paymentApplications)
    return state.paymentApplications as unknown as Record<string, unknown>[];
  throw new Error('fakeDb: unsupported select().from() table');
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

function createFakeDb(opts: { failAuditInsert?: boolean; state?: State } = {}) {
  const state: State = opts.state ?? {
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
          if (table === schema.paymentApplications) {
            state.paymentApplications = state.paymentApplications.filter(
              (r) => !rowMatches(table, r as unknown as Record<string, unknown>, cond),
            );
          } else if (table === schema.transactionLines) {
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
