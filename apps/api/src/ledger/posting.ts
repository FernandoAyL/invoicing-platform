import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.ts';
import { ledgerEntries } from '../db/schema.ts';
import { formatCents, toCents } from '../money.ts';

type Db = NodePgDatabase<typeof schema>;
// Accepts either the top-level db or the `tx` handle inside
// `db.transaction(async (tx) => ...)`, so postLedger can be called atomically
// alongside the document write + its audit row.
type Tx = Parameters<Db['transaction']>[0] extends (tx: infer T, ...args: never[]) => unknown
  ? T
  : never;
type DbOrTx = Db | Tx;

export interface PostingLine {
  accountId: string;
  contactId?: string | null;
  debit?: string | number;
  credit?: string | number;
}

export interface PostLedgerInput {
  orgId: string;
  transactionId: string;
  entryDate: string;
  lines: PostingLine[];
}

export interface LedgerEntryRow {
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

export class UnbalancedError extends Error {
  readonly debitCents: number;
  readonly creditCents: number;

  constructor(debitCents: number, creditCents: number) {
    super(
      `unbalanced posting: debit ${formatCents(debitCents)} != credit ${formatCents(creditCents)}`,
    );
    this.name = 'UnbalancedError';
    this.debitCents = debitCents;
    this.creditCents = creditCents;
  }
}

export class InvalidPostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPostingError';
  }
}

export async function postLedger(tx: DbOrTx, input: PostLedgerInput): Promise<LedgerEntryRow[]> {
  if (input.lines.length === 0) {
    throw new InvalidPostingError('posting requires at least one line');
  }

  let totalDebitCents = 0;
  let totalCreditCents = 0;

  const parsedLines = input.lines.map((line, index) => {
    let debitCents: number;
    let creditCents: number;
    try {
      debitCents = toCents(line.debit ?? 0);
      creditCents = toCents(line.credit ?? 0);
    } catch (err) {
      throw new InvalidPostingError(
        `line ${index}: ${err instanceof Error ? err.message : 'invalid amount'}`,
      );
    }

    if (debitCents < 0 || creditCents < 0) {
      throw new InvalidPostingError(`line ${index}: debit/credit cannot be negative`);
    }
    if (debitCents > 0 && creditCents > 0) {
      throw new InvalidPostingError(`line ${index}: debit and credit cannot both be set`);
    }
    if (debitCents === 0 && creditCents === 0) {
      throw new InvalidPostingError(`line ${index}: debit and credit cannot both be zero`);
    }

    totalDebitCents += debitCents;
    totalCreditCents += creditCents;

    return { ...line, debitCents, creditCents };
  });

  if (totalDebitCents !== totalCreditCents) {
    throw new UnbalancedError(totalDebitCents, totalCreditCents);
  }

  return tx
    .insert(ledgerEntries)
    .values(
      parsedLines.map((line) => ({
        orgId: input.orgId,
        transactionId: input.transactionId,
        accountId: line.accountId,
        contactId: line.contactId ?? null,
        entryDate: input.entryDate,
        debit: formatCents(line.debitCents),
        credit: formatCents(line.creditCents),
      })),
    )
    .returning();
}

export interface ZeroOutLedgerArgs {
  orgId: string;
  transactionId: string;
  entryDate: string;
  contactId: string | null;
}

// Ledger entries are append-only: edits and voids never UPDATE/DELETE a
// posted `LedgerEntry`. Instead this reads every entry posted so far for the
// transaction, nets debit-credit per account, and posts a single balancing
// set that drives each account's net back to zero. Because every prior
// posting was itself balanced (`postLedger` enforces Σdebit=Σcredit), the
// sum of per-account nets is always zero, so the negation is balanced too.
// A no-op (already net zero) posts nothing, making a repeated reversal
// idempotent.
export async function zeroOutLedger(tx: DbOrTx, args: ZeroOutLedgerArgs): Promise<void> {
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
