import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getAccountBySubtype } from '../accounts/service.ts';
import { writeAuditLog } from '../audit/service.ts';
import { getContact } from '../contacts/service.ts';
import type * as schema from '../db/schema.ts';
import {
  accounts,
  ledgerEntries,
  syncLinks,
  transactionLines,
  transactions,
} from '../db/schema.ts';
import { type PostingLine, postLedger, zeroOutLedger } from '../ledger/posting.ts';
import { formatCents, toCents } from '../money.ts';

type Db = NodePgDatabase<typeof schema>;
// Accepts either the top-level db or the `tx` handle inside
// `db.transaction(async (tx) => ...)` so internal helpers can be shared
// between the top-level entry points and the callback body.
type Tx = Parameters<Db['transaction']>[0] extends (tx: infer T, ...args: never[]) => unknown
  ? T
  : never;

export type InvoiceStatus = 'draft' | 'open' | 'partially_paid' | 'paid' | 'void';

// Mirrors the `sync_state` pg enum (db/schema.ts). Every invoice reports
// `pending` until the Phase-2 sync engine writes a `sync_links` row for it -
// see the join in getInvoice/listInvoices below.
export type SyncState = 'pending' | 'synced' | 'conflict' | 'failed';

export interface InvoiceLineInput {
  itemId?: string;
  accountId?: string;
  description?: string;
  quantity: number;
  unitPrice: string | number;
}

export interface CreateInvoiceInput {
  contactId: string;
  txnDate: string;
  dueDate?: string;
  memo?: string;
  docNumber?: string;
  lines: InvoiceLineInput[];
}

export interface UpdateInvoiceInput {
  contactId?: string;
  txnDate?: string;
  dueDate?: string;
  memo?: string;
  docNumber?: string;
  lines?: InvoiceLineInput[];
}

export interface InvoiceLine {
  id: string;
  lineNumber: number;
  itemId: string | null;
  accountId: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface Invoice {
  id: string;
  orgId: string;
  type: 'customer_invoice';
  status: InvoiceStatus;
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
  lines: InvoiceLine[];
  syncState: SyncState;
}

export interface InvoiceContext {
  orgId: string;
  userId: string;
}

export interface ListInvoicesFilter {
  status?: InvoiceStatus;
}

export type DeleteInvoiceAction = 'deleted' | 'skipped';

export interface DeleteInvoiceResult {
  action: DeleteInvoiceAction;
  /** Present only when `action === 'skipped'` (idempotent re-delete). */
  reason?: 'already_deleted';
  invoice: Invoice;
}

export class NotFoundError extends Error {
  constructor(message = 'invoice not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}

export class InvalidContactError extends Error {
  constructor(message = 'invalid contact') {
    super(message);
    this.name = 'InvalidContactError';
  }
}

export class ChartNotSeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChartNotSeededError';
  }
}

export class InvalidLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLineError';
  }
}

interface ResolvedLine {
  lineNumber: number;
  itemId: string | null;
  accountId: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amountCents: number;
}

type TransactionRow = typeof transactions.$inferSelect;
type TransactionLineRow = typeof transactionLines.$inferSelect;

// `syncState` defaults to 'pending' for the create/update/void paths below,
// which never join sync_links (a just-created/edited invoice has no sync
// row yet in Phase 1). getInvoice/listInvoices pass the real joined value.
function toInvoice(
  txn: TransactionRow,
  lines: TransactionLineRow[],
  syncState: SyncState = 'pending',
): Invoice {
  return {
    id: txn.id,
    orgId: txn.orgId,
    type: 'customer_invoice',
    status: txn.status,
    contactId: txn.contactId,
    docNumber: txn.docNumber,
    txnDate: txn.txnDate,
    dueDate: txn.dueDate,
    currency: txn.currency,
    memo: txn.memo,
    subtotal: txn.subtotal,
    total: txn.total,
    balance: txn.balance,
    version: txn.version,
    createdBy: txn.createdBy,
    createdAt: txn.createdAt,
    updatedAt: txn.updatedAt,
    syncState,
    lines: [...lines]
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((line) => ({
        id: line.id,
        lineNumber: line.lineNumber,
        itemId: line.itemId,
        accountId: line.accountId,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount: line.amount,
      })),
  };
}

async function requireCustomerContact(tx: Tx, orgId: string, contactId: string) {
  const contact = await getContact(tx, orgId, contactId);
  if (!contact) throw new InvalidContactError('contact not found in org');
  if (!contact.isCustomer) throw new InvalidContactError('contact is not a customer');
  return contact;
}

async function requireInvoiceAccounts(tx: Tx, orgId: string) {
  const ar = await getAccountBySubtype(tx, orgId, 'accounts_receivable');
  if (!ar) throw new ChartNotSeededError('accounts_receivable account not seeded for org');
  const salesIncome = await getAccountBySubtype(tx, orgId, 'sales_income');
  if (!salesIncome) throw new ChartNotSeededError('sales_income account not seeded for org');
  return { ar, salesIncome };
}

// Resolves + validates raw line input into cents-exact posting-ready lines.
// `quantity` is a JS number (validated positive by the route schema);
// `unitPrice` goes through `toCents`, which rejects more than 2 decimal
// places, so an over-precise price (e.g. 4.995) surfaces here as a 400
// rather than silently rounding.
async function resolveLines(
  tx: Tx,
  orgId: string,
  lines: InvoiceLineInput[],
  defaultIncomeAccountId: string,
): Promise<ResolvedLine[]> {
  if (lines.length === 0) {
    throw new InvalidLineError('at least one line is required');
  }

  const resolved: ResolvedLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new InvalidLineError(`line ${index}: quantity must be greater than 0`);
    }

    let unitPriceCents: number;
    try {
      unitPriceCents = toCents(line.unitPrice);
    } catch {
      throw new InvalidLineError(`line ${index}: invalid unitPrice`);
    }
    if (unitPriceCents < 0) {
      throw new InvalidLineError(`line ${index}: unitPrice cannot be negative`);
    }

    let accountId = line.accountId;
    if (accountId) {
      const [account] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.orgId, orgId), eq(accounts.id, accountId)))
        .limit(1);
      if (!account) throw new InvalidLineError(`line ${index}: accountId not found in org`);
    } else {
      accountId = defaultIncomeAccountId;
    }

    resolved.push({
      lineNumber: index + 1,
      itemId: line.itemId ?? null,
      accountId,
      description: line.description ?? null,
      quantity: String(line.quantity),
      unitPrice: formatCents(unitPriceCents),
      amountCents: Math.round(line.quantity * unitPriceCents),
    });
  }

  return resolved;
}

// Debit A/R for the invoice total, credit each income account for the sum
// of the lines posted to it (multiple lines can share an income account).
function buildInvoicePostings(
  lines: ResolvedLine[],
  arAccountId: string,
  contactId: string | null,
): PostingLine[] {
  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const incomeTotals = new Map<string, number>();
  for (const line of lines) {
    incomeTotals.set(line.accountId, (incomeTotals.get(line.accountId) ?? 0) + line.amountCents);
  }

  const postings: PostingLine[] = [
    { accountId: arAccountId, contactId, debit: formatCents(totalCents) },
  ];
  for (const [accountId, cents] of incomeTotals) {
    postings.push({ accountId, contactId, credit: formatCents(cents) });
  }
  return postings;
}

// Excludes soft-deleted rows (decision §0a.2/§0a.5 "delete then anything -> terminal"): once
// `deletedAt` is set the record is invisible everywhere a user looks, so update/void treat it
// exactly like a nonexistent invoice (404/`NotFoundError`). `deleteInvoice` below uses its OWN
// raw loader (`loadInvoiceRaw`) instead, since it needs to see a soft-deleted row to return the
// idempotent `already_deleted` skip rather than a 404.
async function loadInvoiceForUpdate(tx: Tx, orgId: string, id: string): Promise<TransactionRow> {
  const [existing] = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.orgId, orgId),
        eq(transactions.id, id),
        eq(transactions.type, 'customer_invoice'),
        isNull(transactions.deletedAt),
      ),
    )
    .limit(1);
  if (!existing) throw new NotFoundError();
  return existing;
}

// Raw loader that does NOT filter soft-deleted rows — only `deleteInvoice` uses this, since it
// needs to distinguish "never existed" (404) from "already deleted" (idempotent skip).
async function loadInvoiceRaw(tx: Tx, orgId: string, id: string): Promise<TransactionRow> {
  const [existing] = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.orgId, orgId),
        eq(transactions.id, id),
        eq(transactions.type, 'customer_invoice'),
      ),
    )
    .limit(1);
  if (!existing) throw new NotFoundError();
  return existing;
}

export async function createInvoice(
  db: Db,
  ctx: InvoiceContext,
  input: CreateInvoiceInput,
): Promise<Invoice> {
  return db.transaction(async (tx) => {
    const contact = await requireCustomerContact(tx, ctx.orgId, input.contactId);
    const { ar, salesIncome } = await requireInvoiceAccounts(tx, ctx.orgId);
    const resolvedLines = await resolveLines(tx, ctx.orgId, input.lines, salesIncome.id);
    const totalCents = resolvedLines.reduce((sum, line) => sum + line.amountCents, 0);

    const [txnRow] = await tx
      .insert(transactions)
      .values({
        orgId: ctx.orgId,
        type: 'customer_invoice',
        status: 'open',
        contactId: contact.id,
        docNumber: input.docNumber,
        txnDate: input.txnDate,
        dueDate: input.dueDate,
        memo: input.memo,
        subtotal: formatCents(totalCents),
        total: formatCents(totalCents),
        balance: formatCents(totalCents),
        version: 0,
        createdBy: ctx.userId,
      })
      .returning();
    if (!txnRow) throw new Error('failed to create invoice transaction');

    const lineRows = await tx
      .insert(transactionLines)
      .values(
        resolvedLines.map((line) => ({
          orgId: ctx.orgId,
          transactionId: txnRow.id,
          lineNumber: line.lineNumber,
          itemId: line.itemId,
          accountId: line.accountId,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          amount: formatCents(line.amountCents),
        })),
      )
      .returning();

    await postLedger(tx, {
      orgId: ctx.orgId,
      transactionId: txnRow.id,
      entryDate: input.txnDate,
      lines: buildInvoicePostings(resolvedLines, ar.id, contact.id),
    });

    await writeAuditLog(tx, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      entityType: 'transaction',
      localId: txnRow.id,
      action: 'create',
    });

    return toInvoice(txnRow, lineRows);
  });
}

// Org-scoped LEFT JOIN onto sync_links: entity_type='transaction' (invoices
// are stored as `Transaction` rows) and entity_id = transactions.id, joined
// on transactions.orgId too so a sync_links row can never resolve against a
// transaction from a different org even in the (already prevented by the
// unique constraint) case of an id collision across orgs. No matching row
// -> COALESCE to 'pending', matching a freshly-created invoice.
const syncLinkJoinCondition = and(
  eq(syncLinks.orgId, transactions.orgId),
  eq(syncLinks.entityType, 'transaction'),
  eq(syncLinks.localId, transactions.id),
);

export async function getInvoice(db: Db, orgId: string, id: string): Promise<Invoice | null> {
  const [row] = await db
    .select({
      txn: transactions,
      syncState: sql<SyncState>`coalesce(${syncLinks.state}, 'pending')`,
    })
    .from(transactions)
    .leftJoin(syncLinks, syncLinkJoinCondition)
    .where(
      and(
        eq(transactions.orgId, orgId),
        eq(transactions.id, id),
        eq(transactions.type, 'customer_invoice'),
        // Soft-deleted invoices vanish from every read path (§0a.2) — a deleted invoice 404s here
        // exactly like one that never existed.
        isNull(transactions.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;

  const lines = await db
    .select()
    .from(transactionLines)
    .where(and(eq(transactionLines.orgId, orgId), eq(transactionLines.transactionId, id)));

  return toInvoice(row.txn, lines, row.syncState);
}

export interface LedgerPostingRow {
  id: string;
  accountId: string;
  accountName: string;
  accountCode: string | null;
  accountSubtype: string | null;
  entryDate: string;
  debit: string;
  credit: string;
}

export interface InvoiceLedger {
  entries: LedgerPostingRow[];
  totalDebit: string;
  totalCredit: string;
}

// Read-only (10018): org-scoped over `ledger_entries` for a single invoice's
// posting history. `getInvoice` is called first purely to reuse its
// org-scoping + existence + soft-delete checks (throws `NotFoundError` on a
// missing/cross-org/soft-deleted invoice — never leaks another org's
// postings); the ledger query below re-applies the same org/id filter
// directly against `ledger_entries` rather than trusting the invoice lookup
// alone. Totals are summed in integer cents (money columns are strings) so
// the balance the frontend displays is server-computed, not re-derived
// client-side.
export async function getInvoiceLedger(
  db: Db,
  orgId: string,
  invoiceId: string,
): Promise<InvoiceLedger> {
  const invoice = await getInvoice(db, orgId, invoiceId);
  if (!invoice) throw new NotFoundError();

  const rows = await db
    .select({
      id: ledgerEntries.id,
      accountId: ledgerEntries.accountId,
      accountName: accounts.name,
      accountCode: accounts.code,
      accountSubtype: accounts.subtype,
      entryDate: ledgerEntries.entryDate,
      debit: ledgerEntries.debit,
      credit: ledgerEntries.credit,
      createdAt: ledgerEntries.createdAt,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(and(eq(ledgerEntries.orgId, orgId), eq(ledgerEntries.transactionId, invoiceId)))
    .orderBy(asc(ledgerEntries.entryDate), asc(ledgerEntries.createdAt), asc(ledgerEntries.id));

  let totalDebitCents = 0;
  let totalCreditCents = 0;
  const entries: LedgerPostingRow[] = rows.map((row) => {
    totalDebitCents += toCents(row.debit);
    totalCreditCents += toCents(row.credit);
    return {
      id: row.id,
      accountId: row.accountId,
      accountName: row.accountName,
      accountCode: row.accountCode,
      accountSubtype: row.accountSubtype,
      entryDate: row.entryDate,
      debit: row.debit,
      credit: row.credit,
    };
  });

  return {
    entries,
    totalDebit: formatCents(totalDebitCents),
    totalCredit: formatCents(totalCreditCents),
  };
}

export async function listInvoices(
  db: Db,
  orgId: string,
  filter: ListInvoicesFilter = {},
): Promise<Invoice[]> {
  const conditions = [
    eq(transactions.orgId, orgId),
    eq(transactions.type, 'customer_invoice'),
    // Soft-deleted invoices never appear in lists/counts (§0a.2).
    isNull(transactions.deletedAt),
  ];
  if (filter.status) conditions.push(eq(transactions.status, filter.status));

  const rows = await db
    .select({
      txn: transactions,
      syncState: sql<SyncState>`coalesce(${syncLinks.state}, 'pending')`,
    })
    .from(transactions)
    .leftJoin(syncLinks, syncLinkJoinCondition)
    .where(and(...conditions))
    .orderBy(desc(transactions.txnDate));

  return Promise.all(
    rows.map(async ({ txn, syncState }) => {
      const lines = await db
        .select()
        .from(transactionLines)
        .where(and(eq(transactionLines.orgId, orgId), eq(transactionLines.transactionId, txn.id)));
      return toInvoice(txn, lines, syncState);
    }),
  );
}

export async function updateInvoice(
  db: Db,
  ctx: InvoiceContext,
  id: string,
  patch: UpdateInvoiceInput,
): Promise<Invoice> {
  return db.transaction(async (tx) => {
    const existing = await loadInvoiceForUpdate(tx, ctx.orgId, id);
    if (existing.status !== 'open') {
      throw new InvalidStateError(`cannot edit invoice in status '${existing.status}'`);
    }

    let contactId = existing.contactId;
    if (patch.contactId !== undefined && patch.contactId !== existing.contactId) {
      const contact = await requireCustomerContact(tx, ctx.orgId, patch.contactId);
      contactId = contact.id;
    }

    const { ar, salesIncome } = await requireInvoiceAccounts(tx, ctx.orgId);

    let resolvedLines: ResolvedLine[];
    let lineRows: TransactionLineRow[];

    if (patch.lines) {
      resolvedLines = await resolveLines(tx, ctx.orgId, patch.lines, salesIncome.id);
      await tx
        .delete(transactionLines)
        .where(and(eq(transactionLines.orgId, ctx.orgId), eq(transactionLines.transactionId, id)));
      lineRows = await tx
        .insert(transactionLines)
        .values(
          resolvedLines.map((line) => ({
            orgId: ctx.orgId,
            transactionId: id,
            lineNumber: line.lineNumber,
            itemId: line.itemId,
            accountId: line.accountId,
            description: line.description,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            amount: formatCents(line.amountCents),
          })),
        )
        .returning();
    } else {
      const existingLines = await tx
        .select()
        .from(transactionLines)
        .where(and(eq(transactionLines.orgId, ctx.orgId), eq(transactionLines.transactionId, id)));
      resolvedLines = existingLines.map((line) => ({
        lineNumber: line.lineNumber,
        itemId: line.itemId,
        accountId: line.accountId,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amountCents: toCents(line.amount),
      }));
      lineRows = existingLines;
    }

    const totalCents = resolvedLines.reduce((sum, line) => sum + line.amountCents, 0);
    const txnDate = patch.txnDate ?? existing.txnDate;

    await zeroOutLedger(tx, {
      orgId: ctx.orgId,
      transactionId: id,
      entryDate: txnDate,
      contactId: existing.contactId,
    });
    await postLedger(tx, {
      orgId: ctx.orgId,
      transactionId: id,
      entryDate: txnDate,
      lines: buildInvoicePostings(resolvedLines, ar.id, contactId),
    });

    const [updated] = await tx
      .update(transactions)
      .set({
        contactId,
        txnDate,
        dueDate: patch.dueDate !== undefined ? patch.dueDate : existing.dueDate,
        memo: patch.memo !== undefined ? patch.memo : existing.memo,
        docNumber: patch.docNumber !== undefined ? patch.docNumber : existing.docNumber,
        subtotal: formatCents(totalCents),
        total: formatCents(totalCents),
        balance: formatCents(totalCents),
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.orgId, ctx.orgId), eq(transactions.id, id)))
      .returning();
    if (!updated) throw new Error('failed to update invoice');

    await writeAuditLog(tx, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      entityType: 'transaction',
      localId: id,
      action: 'update',
      detail: { fields: Object.keys(patch) },
    });

    return toInvoice(updated, lineRows);
  });
}

export async function voidInvoice(db: Db, ctx: InvoiceContext, id: string): Promise<Invoice> {
  return db.transaction(async (tx) => {
    const existing = await loadInvoiceForUpdate(tx, ctx.orgId, id);
    if (existing.status !== 'open') {
      throw new InvalidStateError(`cannot void invoice in status '${existing.status}'`);
    }

    await zeroOutLedger(tx, {
      orgId: ctx.orgId,
      transactionId: id,
      entryDate: existing.txnDate,
      contactId: existing.contactId,
    });

    const [updated] = await tx
      .update(transactions)
      .set({
        status: 'void',
        balance: '0.00',
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.orgId, ctx.orgId), eq(transactions.id, id)))
      .returning();
    if (!updated) throw new Error('failed to void invoice');

    const lines = await tx
      .select()
      .from(transactionLines)
      .where(and(eq(transactionLines.orgId, ctx.orgId), eq(transactionLines.transactionId, id)));

    await writeAuditLog(tx, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      entityType: 'transaction',
      localId: id,
      action: 'void',
    });

    return toInvoice(updated, lines);
  });
}

/**
 * Soft-delete (docs/design-decisions.md ## Delete vs void, `.claude/plans/20009-delete-vs-void.md`
 * §0a): distinct from `voidInvoice` — sets `deletedAt` (never a hard row delete, never a status
 * value) so the invoice becomes invisible to `getInvoice`/`listInvoices` while the row + its
 * `ledger_entries`/`sync_links` are retained (a hard delete would destroy the reconciliation trail
 * and let a later sync re-create the record). Zeroes the ledger the same way `voidInvoice` does —
 * a deleted invoice has no accounting effect either. Allowed on `open`/`void` (unpaid) invoices
 * only; `partially_paid`/`paid` invoices have real payments applied, which is a reversal/refund
 * concern (out of scope, mirrors how `voidInvoice` only allows `status === 'open'`). Deleting an
 * already-deleted invoice is an idempotent no-op (`{action: 'skipped', reason: 'already_deleted'}`)
 * rather than a 404 or an error, so a retried delete call never surfaces as a failure.
 */
export async function deleteInvoice(
  db: Db,
  ctx: InvoiceContext,
  id: string,
): Promise<DeleteInvoiceResult> {
  return db.transaction(async (tx) => {
    const existing = await loadInvoiceRaw(tx, ctx.orgId, id);

    const lines = await tx
      .select()
      .from(transactionLines)
      .where(and(eq(transactionLines.orgId, ctx.orgId), eq(transactionLines.transactionId, id)));

    if (existing.deletedAt) {
      return { action: 'skipped', reason: 'already_deleted', invoice: toInvoice(existing, lines) };
    }

    if (existing.status === 'partially_paid' || existing.status === 'paid') {
      throw new InvalidStateError(`cannot delete invoice in status '${existing.status}'`);
    }

    await zeroOutLedger(tx, {
      orgId: ctx.orgId,
      transactionId: id,
      entryDate: existing.txnDate,
      contactId: existing.contactId,
    });

    const [updated] = await tx
      .update(transactions)
      .set({
        deletedAt: new Date(),
        balance: '0.00',
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.orgId, ctx.orgId), eq(transactions.id, id)))
      .returning();
    if (!updated) throw new Error('failed to delete invoice');

    await writeAuditLog(tx, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      entityType: 'transaction',
      localId: id,
      action: 'delete',
    });

    return { action: 'deleted', invoice: toInvoice(updated, lines) };
  });
}
