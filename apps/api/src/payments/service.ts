import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getAccountBySubtype } from '../accounts/service.ts';
import { writeAuditLog } from '../audit/service.ts';
import type * as schema from '../db/schema.ts';
import { accounts, paymentApplications, transactions } from '../db/schema.ts';
import { postLedger, zeroOutLedger } from '../ledger/posting.ts';
import { formatCents, toCents } from '../money.ts';
import { deriveInvoiceStatus } from './status.ts';

type Db = NodePgDatabase<typeof schema>;
// Accepts either the top-level db or the `tx` handle inside
// `db.transaction(async (tx) => ...)`, mirroring invoices/service.ts.
type Tx = Parameters<Db['transaction']>[0] extends (tx: infer T, ...args: never[]) => unknown
  ? T
  : never;

export class NotFoundError extends Error {
  constructor(message = 'not found') {
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

export class OverpaymentError extends Error {
  constructor(message = 'payment amount exceeds the remaining balance') {
    super(message);
    this.name = 'OverpaymentError';
  }
}

export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}

export class InvalidDepositAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDepositAccountError';
  }
}

export class ChartNotSeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChartNotSeededError';
  }
}

export interface PaymentContext {
  orgId: string;
  userId: string;
}

export interface RecordPaymentInput {
  amount: number | string;
  txnDate: string;
  depositAccountId?: string;
  memo?: string;
}

export interface Payment {
  id: string;
  orgId: string;
  type: 'payment';
  status: string;
  contactId: string | null;
  txnDate: string;
  memo: string | null;
  total: string;
  version: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvoiceSummary {
  id: string;
  status: string;
  balance: string;
  version: number;
}

export interface RecordPaymentResult {
  payment: Payment;
  invoice: InvoiceSummary;
}

export interface VoidPaymentResult {
  payment: Payment;
  invoice: InvoiceSummary;
}

type TransactionRow = typeof transactions.$inferSelect;

function toPayment(row: TransactionRow): Payment {
  return {
    id: row.id,
    orgId: row.orgId,
    type: 'payment',
    status: row.status,
    contactId: row.contactId,
    txnDate: row.txnDate,
    memo: row.memo,
    total: row.total,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadInvoice(tx: Tx, orgId: string, invoiceId: string): Promise<TransactionRow> {
  const [row] = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.orgId, orgId),
        eq(transactions.id, invoiceId),
        eq(transactions.type, 'customer_invoice'),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError('invoice not found');
  return row;
}

async function loadPayment(tx: Tx, orgId: string, paymentId: string): Promise<TransactionRow> {
  const [row] = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.orgId, orgId),
        eq(transactions.id, paymentId),
        eq(transactions.type, 'payment'),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError('payment not found');
  return row;
}

async function sumAppliedCents(tx: Tx, orgId: string, invoiceTxnId: string): Promise<number> {
  const rows = await tx
    .select()
    .from(paymentApplications)
    .where(
      and(eq(paymentApplications.orgId, orgId), eq(paymentApplications.invoiceTxnId, invoiceTxnId)),
    );
  return rows.reduce((sum, row) => sum + toCents(row.amount), 0);
}

async function resolveDepositAccount(tx: Tx, orgId: string, depositAccountId?: string) {
  if (depositAccountId) {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), eq(accounts.id, depositAccountId)))
      .limit(1);
    if (!account) throw new NotFoundError('deposit account not found in org');
    if (account.type !== 'asset') {
      throw new InvalidDepositAccountError('deposit account must be an asset account');
    }
    return account;
  }

  const undeposited = await getAccountBySubtype(tx, orgId, 'undeposited_funds');
  if (!undeposited) {
    throw new ChartNotSeededError('undeposited_funds account not seeded for org');
  }
  return undeposited;
}

async function recomputeInvoice(
  tx: Tx,
  orgId: string,
  invoice: TransactionRow,
): Promise<InvoiceSummary> {
  const totalCents = toCents(invoice.total);
  const paidCents = await sumAppliedCents(tx, orgId, invoice.id);
  const status = deriveInvoiceStatus(totalCents, paidCents);

  const [updated] = await tx
    .update(transactions)
    .set({
      status,
      balance: formatCents(totalCents - Math.min(paidCents, totalCents)),
      version: invoice.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.orgId, orgId), eq(transactions.id, invoice.id)))
    .returning();
  if (!updated) throw new Error('failed to recompute invoice');

  return {
    id: updated.id,
    status: updated.status,
    balance: updated.balance,
    version: updated.version,
  };
}

export async function recordPayment(
  db: Db,
  ctx: PaymentContext,
  invoiceId: string,
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  return db.transaction(async (tx) => {
    const invoice = await loadInvoice(tx, ctx.orgId, invoiceId);
    if (invoice.status !== 'open' && invoice.status !== 'partially_paid') {
      throw new InvalidStateError(
        `cannot record a payment against an invoice in status '${invoice.status}'`,
      );
    }

    let amountCents: number;
    try {
      amountCents = toCents(input.amount);
    } catch {
      throw new InvalidAmountError('invalid payment amount');
    }
    if (amountCents <= 0) {
      throw new InvalidAmountError('payment amount must be greater than 0');
    }

    const totalCents = toCents(invoice.total);
    const alreadyPaidCents = await sumAppliedCents(tx, ctx.orgId, invoice.id);
    if (amountCents > totalCents - alreadyPaidCents) {
      throw new OverpaymentError();
    }

    const ar = await getAccountBySubtype(tx, ctx.orgId, 'accounts_receivable');
    if (!ar) throw new ChartNotSeededError('accounts_receivable account not seeded for org');
    const depositAccount = await resolveDepositAccount(tx, ctx.orgId, input.depositAccountId);

    const [paymentRow] = await tx
      .insert(transactions)
      .values({
        orgId: ctx.orgId,
        type: 'payment',
        status: 'paid',
        contactId: invoice.contactId,
        txnDate: input.txnDate,
        memo: input.memo,
        subtotal: formatCents(amountCents),
        total: formatCents(amountCents),
        balance: '0.00',
        version: 0,
        createdBy: ctx.userId,
      })
      .returning();
    if (!paymentRow) throw new Error('failed to create payment transaction');

    await tx.insert(paymentApplications).values({
      orgId: ctx.orgId,
      paymentTxnId: paymentRow.id,
      invoiceTxnId: invoice.id,
      amount: formatCents(amountCents),
    });

    await postLedger(tx, {
      orgId: ctx.orgId,
      transactionId: paymentRow.id,
      entryDate: input.txnDate,
      lines: [
        {
          accountId: depositAccount.id,
          contactId: invoice.contactId,
          debit: formatCents(amountCents),
        },
        { accountId: ar.id, contactId: invoice.contactId, credit: formatCents(amountCents) },
      ],
    });

    const invoiceSummary = await recomputeInvoice(tx, ctx.orgId, invoice);

    await writeAuditLog(tx, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      entityType: 'transaction',
      localId: paymentRow.id,
      action: 'payment',
      detail: { invoiceId: invoice.id, amount: formatCents(amountCents) },
    });

    return { payment: toPayment(paymentRow), invoice: invoiceSummary };
  });
}

export async function voidPayment(
  db: Db,
  ctx: PaymentContext,
  paymentId: string,
): Promise<VoidPaymentResult> {
  return db.transaction(async (tx) => {
    const payment = await loadPayment(tx, ctx.orgId, paymentId);
    if (payment.status === 'void') {
      throw new InvalidStateError('payment is already void');
    }

    const applications = await tx
      .select()
      .from(paymentApplications)
      .where(
        and(
          eq(paymentApplications.orgId, ctx.orgId),
          eq(paymentApplications.paymentTxnId, paymentId),
        ),
      );
    const [application] = applications;
    if (!application) throw new Error('payment has no application to reverse');
    const invoice = await loadInvoice(tx, ctx.orgId, application.invoiceTxnId);

    await zeroOutLedger(tx, {
      orgId: ctx.orgId,
      transactionId: paymentId,
      entryDate: payment.txnDate,
      contactId: payment.contactId,
    });

    await tx
      .delete(paymentApplications)
      .where(
        and(
          eq(paymentApplications.orgId, ctx.orgId),
          eq(paymentApplications.paymentTxnId, paymentId),
        ),
      );

    const [voidedPayment] = await tx
      .update(transactions)
      .set({ status: 'void', version: payment.version + 1, updatedAt: new Date() })
      .where(and(eq(transactions.orgId, ctx.orgId), eq(transactions.id, paymentId)))
      .returning();
    if (!voidedPayment) throw new Error('failed to void payment');

    const invoiceSummary = await recomputeInvoice(tx, ctx.orgId, invoice);

    await writeAuditLog(tx, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      entityType: 'transaction',
      localId: paymentId,
      action: 'void',
      detail: { invoiceId: invoice.id },
    });

    return { payment: toPayment(voidedPayment), invoice: invoiceSummary };
  });
}

export async function listPaymentsForInvoice(
  db: Db,
  orgId: string,
  invoiceId: string,
): Promise<Payment[]> {
  const [invoice] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.orgId, orgId),
        eq(transactions.id, invoiceId),
        eq(transactions.type, 'customer_invoice'),
      ),
    )
    .limit(1);
  if (!invoice) throw new NotFoundError('invoice not found');

  const applications = await db
    .select()
    .from(paymentApplications)
    .where(
      and(eq(paymentApplications.orgId, orgId), eq(paymentApplications.invoiceTxnId, invoiceId)),
    );

  const payments: Payment[] = [];
  for (const application of applications) {
    const [row] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.orgId, orgId), eq(transactions.id, application.paymentTxnId)))
      .limit(1);
    if (row) payments.push(toPayment(row));
  }
  return payments;
}

export async function getPayment(db: Db, orgId: string, id: string): Promise<Payment | null> {
  const [row] = await db
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.orgId, orgId), eq(transactions.id, id), eq(transactions.type, 'payment')),
    )
    .limit(1);
  return row ? toPayment(row) : null;
}
