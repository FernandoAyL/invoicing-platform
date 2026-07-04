import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getAccountBySubtype } from '../accounts/service.ts';
import { writeAuditLog } from '../audit/service.ts';
import { getContact } from '../contacts/service.ts';
import type * as schema from '../db/schema.ts';
import { accounts, ledgerEntries, transactionLines, transactions } from '../db/schema.ts';
import { type PostingLine, postLedger } from '../ledger/posting.ts';
import { formatCents, toCents } from '../money.ts';

type Db = NodePgDatabase<typeof schema>;
// Accepts either the top-level db or the `tx` handle inside
// `db.transaction(async (tx) => ...)` so internal helpers can be shared
// between the top-level entry points and the callback body.
type Tx = Parameters<Db['transaction']>[0] extends (tx: infer T, ...args: never[]) => unknown
  ? T
  : never;

export type InvoiceStatus = 'draft' | 'open' | 'partially_paid' | 'paid' | 'void';

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
}

export interface InvoiceContext {
  orgId: string;
  userId: string;
}

export interface ListInvoicesFilter {
  status?: InvoiceStatus;
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

function toInvoice(txn: TransactionRow, lines: TransactionLineRow[]): Invoice {
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

// Ledger entries are append-only: edits and voids never UPDATE/DELETE a
// posted `LedgerEntry`. Instead this reads every entry posted so far for the
// transaction, nets debit-credit per account, and posts a single balancing
// set that drives each account's net back to zero. Because every prior
// posting was itself balanced (`postLedger` enforces Σdebit=Σcredit), the
// sum of per-account nets is always zero, so the negation is balanced too.
// A no-op (already net zero) posts nothing, making a repeated void idempotent.
async function zeroOutLedger(
  tx: Tx,
  args: { orgId: string; transactionId: string; entryDate: string; contactId: string | null },
): Promise<void> {
  const rows = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(eq(ledgerEntries.orgId, args.orgId), eq(ledgerEntries.transactionId, args.transactionId)),
    );

  const netByAccount = new Map<string, number>();
  for (const row of rows) {
    const net = toCents(row.debit) - toCents(row.credit);
    netByAccount.set(row.accountId, (netByAccount.get(row.accountId) ?? 0) + net);
  }

  const reversalLines: PostingLine[] = [];
  for (const [accountId, net] of netByAccount) {
    if (net === 0) continue;
    reversalLines.push(
      net > 0
        ? { accountId, contactId: args.contactId, credit: formatCents(net) }
        : { accountId, contactId: args.contactId, debit: formatCents(-net) },
    );
  }

  if (reversalLines.length === 0) return;

  await postLedger(tx, {
    orgId: args.orgId,
    transactionId: args.transactionId,
    entryDate: args.entryDate,
    lines: reversalLines,
  });
}

async function loadInvoiceForUpdate(tx: Tx, orgId: string, id: string): Promise<TransactionRow> {
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

export async function getInvoice(db: Db, orgId: string, id: string): Promise<Invoice | null> {
  const [txn] = await db
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
  if (!txn) return null;

  const lines = await db
    .select()
    .from(transactionLines)
    .where(and(eq(transactionLines.orgId, orgId), eq(transactionLines.transactionId, id)));

  return toInvoice(txn, lines);
}

export async function listInvoices(
  db: Db,
  orgId: string,
  filter: ListInvoicesFilter = {},
): Promise<Invoice[]> {
  const conditions = [eq(transactions.orgId, orgId), eq(transactions.type, 'customer_invoice')];
  if (filter.status) conditions.push(eq(transactions.status, filter.status));

  const txns = await db
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(desc(transactions.txnDate));

  return Promise.all(
    txns.map(async (txn) => {
      const lines = await db
        .select()
        .from(transactionLines)
        .where(and(eq(transactionLines.orgId, orgId), eq(transactionLines.transactionId, txn.id)));
      return toInvoice(txn, lines);
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
