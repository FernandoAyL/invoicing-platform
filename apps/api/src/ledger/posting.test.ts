import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as schema from '../db/schema.ts';
import { InvalidPostingError, postLedger, UnbalancedError } from './posting.ts';

interface FakeLedgerRow {
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

function createFakeTx() {
  const inserted: FakeLedgerRow[] = [];
  const tx = {
    insert(table: unknown) {
      if (table !== schema.ledgerEntries) {
        throw new Error('fakeTx: unsupported insert().values() table');
      }
      return {
        values(rows: Array<Record<string, unknown>>) {
          return {
            async returning() {
              const created = rows.map((r) => ({
                id: randomUUID(),
                orgId: r.orgId as string,
                transactionId: r.transactionId as string,
                accountId: r.accountId as string,
                contactId: (r.contactId as string | null) ?? null,
                entryDate: r.entryDate as string,
                debit: r.debit as string,
                credit: r.credit as string,
                createdAt: new Date(),
              }));
              inserted.push(...created);
              return created;
            },
          };
        },
      };
    },
  };
  return { tx, inserted };
}

const BASE_INPUT = {
  orgId: 'org-1',
  transactionId: 'txn-1',
  entryDate: '2026-07-04',
};

describe('postLedger', () => {
  it('inserts balanced two-line postings', async () => {
    const { tx, inserted } = createFakeTx();
    const rows = await postLedger(tx as never, {
      ...BASE_INPUT,
      lines: [
        { accountId: 'ar', debit: '100.00' },
        { accountId: 'sales', credit: '100.00' },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({ accountId: 'ar', debit: '100.00', credit: '0.00' });
    expect(inserted[1]).toMatchObject({ accountId: 'sales', debit: '0.00', credit: '100.00' });
  });

  it('inserts balanced multi-line postings (1 debit / 2 credits)', async () => {
    const { tx, inserted } = createFakeTx();
    await postLedger(tx as never, {
      ...BASE_INPUT,
      lines: [
        { accountId: 'ar', debit: '100.00' },
        { accountId: 'sales', credit: '60.00' },
        { accountId: 'tax', credit: '40.00' },
      ],
    });
    expect(inserted).toHaveLength(3);
  });

  it('balances the float-trap case (0.30 vs 0.10 + 0.20) without float drift', async () => {
    const { tx, inserted } = createFakeTx();
    await postLedger(tx as never, {
      ...BASE_INPUT,
      lines: [
        { accountId: 'a', debit: '0.30' },
        { accountId: 'b', credit: '0.10' },
        { accountId: 'c', credit: '0.20' },
      ],
    });
    expect(inserted).toHaveLength(3);
  });

  it('throws UnbalancedError and inserts nothing when debits != credits', async () => {
    const { tx, inserted } = createFakeTx();
    await expect(
      postLedger(tx as never, {
        ...BASE_INPUT,
        lines: [
          { accountId: 'ar', debit: '100.00' },
          { accountId: 'sales', credit: '90.00' },
        ],
      }),
    ).rejects.toThrow(UnbalancedError);
    expect(inserted).toHaveLength(0);
  });

  it('throws InvalidPostingError for an empty line set', async () => {
    const { tx, inserted } = createFakeTx();
    await expect(postLedger(tx as never, { ...BASE_INPUT, lines: [] })).rejects.toThrow(
      InvalidPostingError,
    );
    expect(inserted).toHaveLength(0);
  });

  it('throws InvalidPostingError for a negative amount', async () => {
    const { tx, inserted } = createFakeTx();
    await expect(
      postLedger(tx as never, {
        ...BASE_INPUT,
        lines: [
          { accountId: 'ar', debit: '-10.00' },
          { accountId: 'sales', credit: '10.00' },
        ],
      }),
    ).rejects.toThrow(InvalidPostingError);
    expect(inserted).toHaveLength(0);
  });

  it('throws InvalidPostingError when both debit and credit are set on a line', async () => {
    const { tx, inserted } = createFakeTx();
    await expect(
      postLedger(tx as never, {
        ...BASE_INPUT,
        lines: [{ accountId: 'ar', debit: '10.00', credit: '10.00' }],
      }),
    ).rejects.toThrow(InvalidPostingError);
    expect(inserted).toHaveLength(0);
  });

  it('throws InvalidPostingError when both debit and credit are zero/absent on a line', async () => {
    const { tx, inserted } = createFakeTx();
    await expect(
      postLedger(tx as never, {
        ...BASE_INPUT,
        lines: [
          { accountId: 'ar', debit: '0' },
          { accountId: 'sales', credit: '0' },
        ],
      }),
    ).rejects.toThrow(InvalidPostingError);
    expect(inserted).toHaveLength(0);
  });

  it('throws InvalidPostingError for a malformed amount', async () => {
    const { tx, inserted } = createFakeTx();
    await expect(
      postLedger(tx as never, {
        ...BASE_INPUT,
        lines: [
          { accountId: 'ar', debit: '1.234' },
          { accountId: 'sales', credit: '1.234' },
        ],
      }),
    ).rejects.toThrow(InvalidPostingError);
    expect(inserted).toHaveLength(0);
  });
});
