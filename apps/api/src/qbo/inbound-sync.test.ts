import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import {
  accounts,
  contacts,
  items,
  ledgerEntries,
  paymentApplications,
  processedEvents,
  syncAuditLogs,
  syncLinks,
  transactions,
  users,
} from '../db/schema.ts';
import { createInvoice, getInvoice } from '../invoices/service.ts';
import { recordPayment } from '../payments/service.ts';
import type { QboEntityEnvelope } from './api-client.ts';
import { recordEventIfNew } from './event-dedup.ts';
import {
  type ApplyInboundEntityInput,
  applyInboundEntity,
  qboCustomerToMatchTarget,
  qboInvoiceToLocalPatch,
  qboInvoiceToMatchTarget,
  qboPaymentToLocalPatch,
} from './inbound-sync.ts';
import { findLinkByLocal, findLinkByQbo, upsertLink } from './sync-link-service.ts';
import type { WebhookEntity } from './webhook-types.ts';

let testDb: TestDb | undefined;

afterEach(async () => {
  await testDb?.cleanup();
  testDb = undefined;
});

// ---------------------------------------------------------------------------
// Pure mapper unit tests — no DB.
// ---------------------------------------------------------------------------

describe('qboInvoiceToLocalPatch', () => {
  it('only includes fields QBO actually sent', () => {
    expect(qboInvoiceToLocalPatch({ TxnDate: '2026-02-01' })).toEqual({ txnDate: '2026-02-01' });
    expect(qboInvoiceToLocalPatch({})).toEqual({});
  });

  it('maps DocNumber/DueDate/PrivateNote to null when QBO clears them (present but not a string)', () => {
    expect(qboInvoiceToLocalPatch({ DocNumber: null, DueDate: null, PrivateNote: null })).toEqual({
      docNumber: null,
      dueDate: null,
      memo: null,
    });
  });

  it('maps every metadata field when present', () => {
    expect(
      qboInvoiceToLocalPatch({
        DocNumber: 'INV-99',
        TxnDate: '2026-03-01',
        DueDate: '2026-03-15',
        PrivateNote: 'updated memo',
      }),
    ).toEqual({
      docNumber: 'INV-99',
      txnDate: '2026-03-01',
      dueDate: '2026-03-15',
      memo: 'updated memo',
    });
  });
});

describe('qboPaymentToLocalPatch', () => {
  it('maps TxnDate/PrivateNote only — never an amount field', () => {
    expect(
      qboPaymentToLocalPatch({ TxnDate: '2026-02-01', PrivateNote: 'note', TotalAmt: 999 }),
    ).toEqual({
      txnDate: '2026-02-01',
      memo: 'note',
    });
  });
});

describe('qboInvoiceToMatchTarget', () => {
  it('extracts docNumber/total/txnDate/customerQboId from a QBO invoice envelope body', () => {
    expect(
      qboInvoiceToMatchTarget({
        DocNumber: 'INV-1',
        TotalAmt: 100,
        TxnDate: '2026-01-01',
        CustomerRef: { value: 'qbo-cust-1' },
      }),
    ).toEqual({
      docNumber: 'INV-1',
      total: 100,
      txnDate: '2026-01-01',
      customerQboId: 'qbo-cust-1',
    });
  });

  it('defaults missing fields safely (no docNumber/customerRef)', () => {
    expect(qboInvoiceToMatchTarget({ TotalAmt: 50, TxnDate: '2026-01-01' })).toEqual({
      docNumber: null,
      total: 50,
      txnDate: '2026-01-01',
      customerQboId: null,
    });
  });
});

describe('qboCustomerToMatchTarget', () => {
  it('extracts email + displayName', () => {
    expect(
      qboCustomerToMatchTarget({
        DisplayName: 'Acme Co',
        PrimaryEmailAddr: { Address: 'a@b.test' },
      }),
    ).toEqual({ email: 'a@b.test', displayName: 'Acme Co' });
  });

  it('defaults email to null and displayName to empty string when absent', () => {
    expect(qboCustomerToMatchTarget({})).toEqual({ email: null, displayName: '' });
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real Postgres via pglite.
// ---------------------------------------------------------------------------

async function seedOrg(db: TestDb['db']) {
  const { orgId } = await seedBaseOrg(db);
  const [user] = await db
    .insert(users)
    .values({ orgId, email: 'owner@example.test', passwordHash: 'hash' })
    .returning();
  if (!user) throw new Error('setup: user insert returned no row');

  const [ar, salesIncome, undeposited] = await db
    .insert(accounts)
    .values([
      { orgId, name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
      { orgId, name: 'Sales Income', type: 'income', subtype: 'sales_income' },
      { orgId, name: 'Undeposited Funds', type: 'asset', subtype: 'undeposited_funds' },
    ])
    .returning();
  if (!ar || !salesIncome || !undeposited) throw new Error('setup: account insert short');

  const [contact] = await db
    .insert(contacts)
    .values({ orgId, displayName: 'Acme Co', email: 'acme@example.test', isCustomer: true })
    .returning();
  if (!contact) throw new Error('setup: contact insert returned no row');

  const [item] = await db
    .insert(items)
    .values({ orgId, name: 'Consulting', kind: 'service' })
    .returning();
  if (!item) throw new Error('setup: item insert returned no row');

  return { orgId, userId: user.id, ar, salesIncome, undeposited, contact, item };
}

async function seedInvoice(
  db: TestDb['db'],
  seed: Awaited<ReturnType<typeof seedOrg>>,
  overrides: { docNumber?: string; txnDate?: string; contactId?: string } = {},
) {
  return createInvoice(
    db,
    { orgId: seed.orgId, userId: seed.userId },
    {
      contactId: overrides.contactId ?? seed.contact.id,
      txnDate: overrides.txnDate ?? '2026-01-01',
      docNumber: overrides.docNumber ?? 'INV-1',
      lines: [{ itemId: seed.item.id, quantity: 2, unitPrice: '50.00' }],
    },
  );
}

function invoiceEntity(overrides: Partial<WebhookEntity> = {}): WebhookEntity {
  return { name: 'Invoice', id: 'qbo-inv-1', operation: 'Update', ...overrides };
}

function paymentEntity(overrides: Partial<WebhookEntity> = {}): WebhookEntity {
  return { name: 'Payment', id: 'qbo-pay-1', operation: 'Update', ...overrides };
}

function customerEntity(overrides: Partial<WebhookEntity> = {}): WebhookEntity {
  return { name: 'Customer', id: 'qbo-cust-1', operation: 'Update', ...overrides };
}

function invoiceEnvelope(overrides: Record<string, unknown> = {}): QboEntityEnvelope {
  return {
    Invoice: {
      Id: 'qbo-inv-1',
      SyncToken: '3',
      DocNumber: 'INV-1',
      TxnDate: '2026-01-01',
      TotalAmt: 100,
      ...overrides,
    },
  };
}

function paymentEnvelope(overrides: Record<string, unknown> = {}): QboEntityEnvelope {
  return { Payment: { Id: 'qbo-pay-1', SyncToken: '1', TxnDate: '2026-01-05', ...overrides } };
}

function customerEnvelope(overrides: Record<string, unknown> = {}): QboEntityEnvelope {
  return {
    Customer: {
      Id: 'qbo-cust-1',
      SyncToken: '2',
      DisplayName: 'Acme Co',
      PrimaryEmailAddr: { Address: 'acme@example.test' },
      ...overrides,
    },
  };
}

function baseInput(
  overrides: Partial<ApplyInboundEntityInput> = {},
): Omit<ApplyInboundEntityInput, 'orgId'> {
  return {
    realmId: 'realm-1',
    entityType: 'Invoice',
    entity: invoiceEntity(),
    refetched: invoiceEnvelope(),
    ...overrides,
  };
}

/** Filters to `direction: 'inbound'` audit rows — seeding via `createInvoice`/`recordPayment`
 * writes its own `direction: 'local'` audit rows that aren't relevant to what these tests are
 * asserting about the inbound-apply path. */
async function auditsFor(db: TestDb['db'], orgId: string) {
  const rows = await db.select().from(syncAuditLogs).where(eq(syncAuditLogs.orgId, orgId));
  return rows.filter((r) => r.direction === 'inbound');
}

describe('applyInboundEntity — Invoice', () => {
  it('linked + Update: patches metadata, leaves amounts untouched, ledger stays balanced', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
      qboSyncToken: '0',
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          refetched: invoiceEnvelope({ DocNumber: 'INV-1-EDITED', PrivateNote: 'from qbo' }),
        }),
      }),
    );

    expect(result).toEqual({ action: 'updated', localId: invoice.id });

    const [updated] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(updated?.docNumber).toBe('INV-1-EDITED');
    expect(updated?.memo).toBe('from qbo');
    // Amount is the documented boundary — never touched by the metadata-only apply path.
    expect(updated?.total).toBe('100.00');

    const ledgerRows = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, invoice.id));
    const debit = ledgerRows.reduce((sum, r) => sum + Number(r.debit), 0);
    const credit = ledgerRows.reduce((sum, r) => sum + Number(r.credit), 0);
    expect(debit).toBeCloseTo(credit, 2);

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.qboSyncToken).toBe('3');

    const audits = await auditsFor(testDb.db, seed.orgId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'qbo.inbound.update',
      outcome: 'success',
      direction: 'inbound',
    });
  });

  it('linked + Void: voids the local invoice and zeroes the ledger', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ entity: invoiceEntity({ operation: 'Void' }) }),
      }),
    );

    expect(result).toEqual({ action: 'voided', localId: invoice.id });
    const [updated] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(updated?.status).toBe('void');
    expect(updated?.balance).toBe('0.00');

    const netByAccount = new Map<string, number>();
    const ledgerRows = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, invoice.id));
    for (const row of ledgerRows) {
      const net = Number(row.debit) - Number(row.credit);
      netByAccount.set(row.accountId, (netByAccount.get(row.accountId) ?? 0) + net);
    }
    for (const net of netByAccount.values()) expect(net).toBe(0);
  });

  it('linked + Delete soft-deletes (distinct from Void, 20009): deletedAt set, ledger zeroed, invisible to reads', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ entity: invoiceEntity({ operation: 'Delete' }) }),
      }),
    );
    expect(result).toEqual({ action: 'deleted', localId: invoice.id });

    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    // Deleted, not voided: `status` is untouched by delete (deletedAt is orthogonal to status —
    // it started 'open' and stays 'open'), while `deletedAt` is now set and the ledger is zeroed.
    expect(row?.status).toBe('open');
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.balance).toBe('0.00');

    const netByAccount = new Map<string, number>();
    const ledgerRows = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, invoice.id));
    for (const ledgerRow of ledgerRows) {
      const net = Number(ledgerRow.debit) - Number(ledgerRow.credit);
      netByAccount.set(ledgerRow.accountId, (netByAccount.get(ledgerRow.accountId) ?? 0) + net);
    }
    for (const net of netByAccount.values()) expect(net).toBe(0);

    const audits = await auditsFor(testDb.db, seed.orgId);
    expect(audits.some((a) => a.action === 'qbo.inbound.delete' && a.outcome === 'success')).toBe(
      true,
    );
  });

  // Anti-tautology headline (20009 plan §4): Delete and Void must produce two DIFFERENT
  // persisted states from the same starting invoice — a synced-then-deleted row disappears from
  // `isNull(deletedAt)` reads, while a synced-then-voided row stays present with status 'void'.
  // Collapsing them back to one behavior (the pre-20009 shape) would make this assertion fail.
  it('Delete vs Void on two otherwise-identical linked invoices produce different persisted state', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);

    const deletedInvoice = await seedInvoice(testDb.db, seed, { docNumber: 'INV-DEL' });
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: deletedInvoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-del',
      state: 'synced',
    });
    const voidedInvoice = await seedInvoice(testDb.db, seed, { docNumber: 'INV-VOID' });
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: voidedInvoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-void',
      state: 'synced',
    });

    const deleteResult = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Invoice',
        entity: invoiceEntity({ id: 'qbo-inv-del', operation: 'Delete' }),
        refetched: invoiceEnvelope({ Id: 'qbo-inv-del', DocNumber: 'INV-DEL' }),
      }),
    );
    const voidResult = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Invoice',
        entity: invoiceEntity({ id: 'qbo-inv-void', operation: 'Void' }),
        refetched: invoiceEnvelope({ Id: 'qbo-inv-void', DocNumber: 'INV-VOID' }),
      }),
    );

    expect(deleteResult).toEqual({ action: 'deleted', localId: deletedInvoice.id });
    expect(voidResult).toEqual({ action: 'voided', localId: voidedInvoice.id });

    const rows = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.orgId, seed.orgId));
    const deletedRow = rows.find((r) => r.id === deletedInvoice.id);
    const voidedRow = rows.find((r) => r.id === voidedInvoice.id);

    // Deleted: deletedAt set, status untouched (still 'open') -> excluded by isNull(deletedAt).
    expect(deletedRow?.deletedAt).not.toBeNull();
    expect(deletedRow?.status).toBe('open');
    // Voided: deletedAt stays null, status flips to 'void' -> still visible, present as void.
    expect(voidedRow?.deletedAt).toBeNull();
    expect(voidedRow?.status).toBe('void');

    // Read-path proof: getInvoice excludes the deleted one, still returns the voided one.
    const deletedRead = await getInvoice(testDb.db, seed.orgId, deletedInvoice.id);
    const voidedRead = await getInvoice(testDb.db, seed.orgId, voidedInvoice.id);
    expect(deletedRead).toBeNull();
    expect(voidedRead?.status).toBe('void');
  });

  it('no re-creation: after an inbound delete, a later Update for the same qboId never resurrects the record (link retained)', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
    });

    const deleteResult = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ entity: invoiceEntity({ operation: 'Delete' }) }),
      }),
    );
    expect(deleteResult).toEqual({ action: 'deleted', localId: invoice.id });

    // The link is retained (still resolvable by qboId) — a later redelivered/legitimate Update
    // for the same qboId hits the LINKED path, not natural-key matching, and is a terminal no-op:
    // it must never patch metadata back in or clear `deletedAt` (there is no un-delete).
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link).not.toBeNull();
    expect(link?.qboId).toBe('qbo-inv-1');

    const updateResult = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          entity: invoiceEntity({ operation: 'Update' }),
          refetched: invoiceEnvelope({ DocNumber: 'RESURRECTED', PrivateNote: 'should not land' }),
        }),
      }),
    );
    expect(updateResult).toEqual({
      action: 'skipped',
      localId: invoice.id,
      reason: 'already_deleted',
    });

    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.deletedAt).not.toBeNull();
    // Anti-tautology: the metadata patch from the "resurrecting" Update must NOT have landed.
    expect(row?.docNumber).toBe('INV-1');
    expect(row?.memo).toBeNull();

    // And it's still invisible on every read path.
    const stillDeleted = await getInvoice(testDb.db, seed.orgId, invoice.id);
    expect(stillDeleted).toBeNull();
  });

  it('void on an already-void invoice is a skipped no-op (idempotent)', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
    });
    await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ entity: invoiceEntity({ operation: 'Void' }) }),
      }),
    );

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ entity: invoiceEntity({ operation: 'Void' }) }),
      }),
    );
    expect(result).toEqual({ action: 'skipped', localId: invoice.id, reason: 'already_void' });
  });

  it('update on a locally-voided invoice is skipped — never un-voids (conflict handling is 20010)', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
    });
    await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ entity: invoiceEntity({ operation: 'Void' }) }),
      }),
    );

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ entity: invoiceEntity({ operation: 'Update' }) }),
      }),
    );
    expect(result).toEqual({
      action: 'skipped',
      localId: invoice.id,
      reason: 'local_already_void_no_unvoid',
    });
  });

  it('unlinked + exactly one natural-key match: links (synced) and applies the metadata patch', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed, { docNumber: 'INV-42' });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          entity: invoiceEntity({ operation: 'Update' }),
          refetched: invoiceEnvelope({ DocNumber: 'INV-42', PrivateNote: 'linked from qbo' }),
        }),
      }),
    );

    expect(result).toEqual({ action: 'linked', localId: invoice.id });
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link).toMatchObject({ state: 'synced', qboType: 'Invoice', qboId: 'qbo-inv-1' });

    const [updated] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(updated?.memo).toBe('linked from qbo');
  });

  it('unlinked + two matching candidates (ambiguous): no link created, skipped audit', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedInvoice(testDb.db, seed, { docNumber: 'INV-DUP' });
    await seedInvoice(testDb.db, seed, { docNumber: 'INV-DUP' });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ refetched: invoiceEnvelope({ DocNumber: 'INV-DUP' }) }),
      }),
    );

    expect(result.action).toBe('unmatched');
    expect(result.reason).toBe('ambiguous_natural_key_match');
    const links = await testDb.db.select().from(syncLinks).where(eq(syncLinks.orgId, seed.orgId));
    expect(links).toHaveLength(0);
  });

  it('unlinked invoice whose refetched state has no mappable sales lines: skipped, not created (30016)', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          entity: invoiceEntity({ id: 'qbo-no-lines', operation: 'Update' }),
          // No `Line` array -> nothing to post -> can't create a balanced invoice.
          refetched: invoiceEnvelope({ Id: 'qbo-no-lines', DocNumber: 'NO-LINES' }),
        }),
      }),
    );
    expect(result).toEqual({ action: 'skipped', reason: 'inbound_create_no_lines' });
    const rows = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.orgId, seed.orgId));
    expect(rows).toHaveLength(0);
  });

  it('unlinked + no natural-key match + full QBO state: imports the invoice — creates, links, posts a balanced ledger (30016)', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          entity: invoiceEntity({ id: 'qbo-import-1', operation: 'Create' }),
          refetched: invoiceEnvelope({
            Id: 'qbo-import-1',
            SyncToken: '0',
            DocNumber: 'IMPORT-1',
            TxnDate: '2026-04-01',
            TotalAmt: 300,
            CustomerRef: { value: 'qbo-cust-99', name: 'Imported Co' },
            Line: [
              {
                Amount: 300,
                DetailType: 'SalesItemLineDetail',
                Description: 'Imported work',
                SalesItemLineDetail: { Qty: 3, UnitPrice: 100 },
              },
            ],
          }),
        }),
      }),
    );

    expect(result.action).toBe('created');
    const localId = result.localId;
    if (!localId) throw new Error('expected a created localId');

    const [invoice] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, localId));
    expect(invoice?.type).toBe('customer_invoice');
    expect(invoice?.status).toBe('open');
    expect(invoice?.docNumber).toBe('IMPORT-1');
    expect(invoice?.txnDate).toBe('2026-04-01');
    expect(invoice?.total).toBe('300.00');
    expect(invoice?.balance).toBe('300.00');

    // Linked to the QBO invoice id, keyed for every future event.
    const invLink = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', localId);
    expect(invLink?.qboId).toBe('qbo-import-1');
    expect(invLink?.state).toBe('synced');
    expect(invLink?.localVersion).toBe(0);

    // Contact resolved from CustomerRef: a new contact created + linked to the QBO customer id.
    const contactLink = await findLinkByQbo(testDb.db, seed.orgId, 'Customer', 'qbo-cust-99');
    expect(contactLink?.state).toBe('synced');
    expect(invoice?.contactId).toBe(contactLink?.localId);
    const [newContact] = await testDb.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactLink?.localId ?? ''));
    expect(newContact?.displayName).toBe('Imported Co');
    expect(newContact?.isCustomer).toBe(true);

    // Balanced ledger: debit A/R 300 / credit income 300 (net zero across accounts).
    const ledger = await testDb.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, localId));
    const net = ledger.reduce((sum, r) => sum + Number(r.debit) - Number(r.credit), 0);
    expect(net).toBe(0);
    const totalDebit = ledger.reduce((sum, r) => sum + Number(r.debit), 0);
    expect(totalDebit).toBe(300);

    const created = (await auditsFor(testDb.db, seed.orgId)).filter(
      (r) => r.action === 'qbo.inbound.create',
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ outcome: 'success', localId });
  });

  it('inbound create reuses an already-linked contact instead of creating a duplicate (30016)', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    // The org's existing Acme contact is already linked to QBO customer qbo-cust-1.
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'contact',
      localId: seed.contact.id,
      qboType: 'Customer',
      qboId: 'qbo-cust-1',
      state: 'synced',
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          entity: invoiceEntity({ id: 'qbo-import-2', operation: 'Create' }),
          refetched: invoiceEnvelope({
            Id: 'qbo-import-2',
            DocNumber: 'IMPORT-2',
            TotalAmt: 50,
            CustomerRef: { value: 'qbo-cust-1', name: 'Acme Co' },
            Line: [
              { Amount: 50, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1 } },
            ],
          }),
        }),
      }),
    );

    expect(result.action).toBe('created');
    const [invoice] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, result.localId ?? ''));
    expect(invoice?.contactId).toBe(seed.contact.id); // reused, not a new contact

    const allContacts = await testDb.db
      .select()
      .from(contacts)
      .where(eq(contacts.orgId, seed.orgId));
    expect(allContacts).toHaveLength(1); // still just the seeded Acme contact
  });

  it('void/delete of an unlinked invoice is skipped — nothing local to void', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedInvoice(testDb.db, seed);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ entity: invoiceEntity({ operation: 'Void' }) }),
      }),
    );
    expect(result).toEqual({ action: 'skipped', reason: 'unlinked_nothing_to_void' });
  });

  it('a refetch envelope missing the Invoice body is a skipped failure, never crashes', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, { orgId: seed.orgId, ...baseInput({ refetched: {} }) }),
    );
    expect(result).toEqual({ action: 'skipped', reason: 'refetch_missing_entity_body' });
  });
});

// ---------------------------------------------------------------------------
// Ordering guard (20008, `.claude/plans/20008-ordering.md`): stale inbound applies must be
// skipped+audited, never clobbering a locally-applied newer SyncToken.
// ---------------------------------------------------------------------------

describe('applyInboundEntity — linked Invoice ordering guard (20008)', () => {
  it('a stale Update (lower SyncToken than already applied) is skipped — persisted record UNCHANGED, link token untouched', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
      qboSyncToken: '3',
      lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          refetched: invoiceEnvelope({ SyncToken: '2', DocNumber: 'STALE-SHOULD-NOT-LAND' }),
        }),
      }),
    );

    expect(result).toEqual({ action: 'skipped', localId: invoice.id, reason: 'stale_ignored' });

    // Anti-tautology: asserts the persisted row, not merely the returned action — removing the
    // guard would re-apply the stale patch and this would read 'STALE-SHOULD-NOT-LAND'.
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.docNumber).toBe('INV-1');

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.qboSyncToken).toBe('3');

    const audits = await auditsFor(testDb.db, seed.orgId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'qbo.inbound.skip',
      outcome: 'skipped',
      direction: 'inbound',
    });
    expect((audits[0]?.detail as Record<string, unknown> | null)?.reason).toBe('stale_ignored');
  });

  it('equal SyncToken is treated as stale (idempotent skip, exact boundary)', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
      qboSyncToken: '3',
      lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ refetched: invoiceEnvelope({ SyncToken: '3' }) }),
      }),
    );
    expect(result).toEqual({ action: 'skipped', localId: invoice.id, reason: 'stale_ignored' });
  });

  it('after a stale skip, a genuinely newer SyncToken still applies', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
      qboSyncToken: '3',
      lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    });

    // Stale (SyncToken 2) — ignored.
    await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ refetched: invoiceEnvelope({ SyncToken: '2' }) }),
      }),
    );

    // Newer (SyncToken 4) — applies.
    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          refetched: invoiceEnvelope({ SyncToken: '4', DocNumber: 'INV-1-FRESH' }),
        }),
      }),
    );
    expect(result).toEqual({ action: 'updated', localId: invoice.id });

    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.docNumber).toBe('INV-1-FRESH');

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.qboSyncToken).toBe('4');
  });

  it('a stale Void (lower SyncToken than an already-applied Update) is skipped — never resurrects/zeroes over newer state', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
      qboSyncToken: '5',
      lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          entity: invoiceEntity({ operation: 'Void' }),
          refetched: invoiceEnvelope({ SyncToken: '4' }),
        }),
      }),
    );
    expect(result).toEqual({ action: 'skipped', localId: invoice.id, reason: 'stale_ignored' });

    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.status).not.toBe('void');
  });

  it('a stale Delete (lower SyncToken than an already-applied change) is skipped — never soft-deletes over newer state', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
      qboSyncToken: '5',
      lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          entity: invoiceEntity({ operation: 'Delete' }),
          refetched: invoiceEnvelope({ SyncToken: '4' }),
        }),
      }),
    );
    expect(result).toEqual({ action: 'skipped', localId: invoice.id, reason: 'stale_ignored' });

    // Anti-tautology: asserts the persisted row + the read path, not merely the returned action —
    // a broken guard would soft-delete here and both of these would fail.
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.deletedAt).toBeNull();
    expect(row?.status).not.toBe('void');

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.qboSyncToken).toBe('5');

    const stillVisible = await getInvoice(testDb.db, seed.orgId, invoice.id);
    expect(stillVisible).not.toBeNull();
  });

  it('20007 seam fix: linking+patching an unlinked invoice re-stamps localVersion to the POST-patch txn version', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed, { docNumber: 'INV-SEAM' });
    expect(invoice.version).toBe(0);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          refetched: invoiceEnvelope({ DocNumber: 'INV-SEAM', PrivateNote: 'linked+patched' }),
        }),
      }),
    );
    expect(result).toEqual({ action: 'linked', localId: invoice.id });

    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    // The metadata patch bumped the txn to version 1.
    expect(row?.version).toBe(1);

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    // Before the seam fix, this stayed at the PRE-patch version (0) — the link's recorded
    // version must match what's actually applied so the outbound guard doesn't re-push a
    // document that's already current.
    expect(link?.localVersion).toBe(1);
  });
});

describe('applyInboundEntity — both-sides-changed conflict (20010)', () => {
  async function seedLinkedInvoice(
    seed: Awaited<ReturnType<typeof seedOrg>>,
    overrides: { qboSyncToken?: string } = {},
  ) {
    const db = testDb?.db as TestDb['db'];
    const invoice = await seedInvoice(db, seed);
    await upsertLink(db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
      localVersion: invoice.version,
      qboSyncToken: overrides.qboSyncToken ?? '3',
      lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    });
    return invoice;
  }

  async function dirtyLocally(id: string, currentVersion: number) {
    await (testDb?.db as TestDb['db'])
      .update(transactions)
      .set({ version: currentVersion + 1, memo: 'local edit' })
      .where(eq(transactions.id, id));
  }

  it('linked + Update: local dirty AND incoming genuinely newer -> conflict, NO mutation, stored SyncToken/localVersion untouched', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedLinkedInvoice(seed);
    await dirtyLocally(invoice.id, invoice.version);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          refetched: invoiceEnvelope({ SyncToken: '4', DocNumber: 'FROM-QBO-SHOULD-NOT-LAND' }),
        }),
      }),
    );

    expect(result).toEqual({
      action: 'conflict',
      localId: invoice.id,
      reason: 'both_sides_changed',
    });

    // Anti-tautology: assert the persisted row, not merely the returned action.
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.docNumber).toBe('INV-1');
    expect(row?.memo).toBe('local edit');

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('conflict');
    expect(link?.conflictDetectedAt).not.toBeNull();
    // Pre-conflict snapshot preserved so resolution can compare against it.
    expect(link?.qboSyncToken).toBe('3');

    const audits = await auditsFor(testDb.db, seed.orgId);
    expect(audits.some((a) => a.action === 'qbo.inbound.conflict' && a.outcome === 'skipped')).toBe(
      true,
    );
  });

  // Anti-tautology headline (plan §4): a local-CLEAN control with the SAME inbound Update must
  // still apply normally — proves the conflict check reflects the local-dirty condition, not an
  // always-on branch that would also fire here.
  it('control: local CLEAN with the same inbound Update still applies normally', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedLinkedInvoice(seed);
    // No dirtyLocally() call — link.localVersion === transactions.version, i.e. clean.

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          refetched: invoiceEnvelope({ SyncToken: '4', DocNumber: 'INV-1-FROM-QBO' }),
        }),
      }),
    );

    expect(result).toEqual({ action: 'updated', localId: invoice.id });
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.docNumber).toBe('INV-1-FROM-QBO');
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('synced');
  });

  it('linked + Void: local dirty (edited, not voided) + genuinely-newer inbound Void -> conflict, not a silent void (20008 carried-forward edge)', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedLinkedInvoice(seed);
    await dirtyLocally(invoice.id, invoice.version);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          entity: invoiceEntity({ operation: 'Void' }),
          refetched: invoiceEnvelope({ SyncToken: '4' }),
        }),
      }),
    );

    expect(result).toEqual({
      action: 'conflict',
      localId: invoice.id,
      reason: 'both_sides_changed',
    });
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.status).not.toBe('void');
  });

  it('linked + Delete: both-sides-changed -> conflict, never soft-deletes over a local edit', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedLinkedInvoice(seed);
    await dirtyLocally(invoice.id, invoice.version);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          entity: invoiceEntity({ operation: 'Delete' }),
          refetched: invoiceEnvelope({ SyncToken: '4' }),
        }),
      }),
    );

    expect(result).toEqual({
      action: 'conflict',
      localId: invoice.id,
      reason: 'both_sides_changed',
    });
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.deletedAt).toBeNull();
  });

  it('voided-in-both: a locally PAID invoice + a genuinely-newer inbound Void -> conflict (NOT the old silent zero-ledger); payment_applications intact, A/R never driven negative', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await recordPayment(testDb.db, { orgId: seed.orgId, userId: seed.userId }, invoice.id, {
      amount: '100.00',
      txnDate: '2026-01-05',
    });
    const [paidInvoice] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    if (!paidInvoice) throw new Error('setup: paid invoice not found');
    expect(paidInvoice.status).toBe('paid');

    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
      localVersion: paidInvoice.version,
      qboSyncToken: '3',
      lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    });
    // Dirty beyond the recorded-payment version — both sides changed since last sync.
    await dirtyLocally(invoice.id, paidInvoice.version);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          entity: invoiceEntity({ operation: 'Void' }),
          refetched: invoiceEnvelope({ SyncToken: '4' }),
        }),
      }),
    );
    expect(result).toEqual({
      action: 'conflict',
      localId: invoice.id,
      reason: 'both_sides_changed',
    });

    const applications = await testDb.db
      .select()
      .from(paymentApplications)
      .where(eq(paymentApplications.invoiceTxnId, invoice.id));
    expect(applications).toHaveLength(1);

    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.status).toBe('paid');
    expect(Number(row?.balance)).toBeGreaterThanOrEqual(0);
  });

  it('repeated inbound while already in conflict is held — idempotent, no mutation, stays conflict', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedLinkedInvoice(seed);
    await dirtyLocally(invoice.id, invoice.version);

    const first = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ refetched: invoiceEnvelope({ SyncToken: '4' }) }),
      }),
    );
    expect(first.action).toBe('conflict');

    // A second, even-newer inbound event arrives while the link is still `conflict`.
    const second = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          refetched: invoiceEnvelope({ SyncToken: '5', DocNumber: 'SHOULD-STILL-NOT-LAND' }),
        }),
      }),
    );
    expect(second).toEqual({
      action: 'conflict',
      localId: invoice.id,
      reason: 'conflict_held',
    });

    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.docNumber).toBe('INV-1');

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('conflict');

    const audits = await auditsFor(testDb.db, seed.orgId);
    expect(audits.some((a) => a.action === 'qbo.inbound.conflict_held')).toBe(true);
  });

  it('bypassConflict (resolution winner=qbo re-drive): applies despite an in-conflict link, clears conflictDetectedAt', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedLinkedInvoice(seed);
    await dirtyLocally(invoice.id, invoice.version);

    await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ refetched: invoiceEnvelope({ SyncToken: '4' }) }),
      }),
    );
    const conflicted = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(conflicted?.state).toBe('conflict');

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          refetched: invoiceEnvelope({ SyncToken: '4', DocNumber: 'FROM-QBO-BYPASS' }),
        }),
        bypassConflict: true,
      }),
    );
    expect(result).toEqual({ action: 'updated', localId: invoice.id });

    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.docNumber).toBe('FROM-QBO-BYPASS');

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('synced');
    expect(link?.conflictDetectedAt).toBeNull();
  });
});

describe('applyInboundEntity — Payment', () => {
  async function seedPaidInvoice(seed: Awaited<ReturnType<typeof seedOrg>>) {
    const invoice = await seedInvoice(testDb?.db as TestDb['db'], seed);
    const { payment } = await recordPayment(
      testDb?.db as TestDb['db'],
      { orgId: seed.orgId, userId: seed.userId },
      invoice.id,
      { amount: '100.00', txnDate: '2026-01-05' },
    );
    return { invoice, payment };
  }

  it('linked + Update: patches txnDate/memo only, never the amount', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const { payment } = await seedPaidInvoice(seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: payment.id,
      qboType: 'Payment',
      qboId: 'qbo-pay-1',
      state: 'synced',
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Payment',
        entity: paymentEntity(),
        refetched: paymentEnvelope({ PrivateNote: 'edited in qbo' }),
      }),
    );

    expect(result).toEqual({ action: 'updated', localId: payment.id });
    const [updated] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, payment.id));
    expect(updated?.memo).toBe('edited in qbo');
    expect(updated?.total).toBe('100.00');
  });

  it('linked + Void: voids the payment, removes its application, and restores the invoice balance', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const { invoice, payment } = await seedPaidInvoice(seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: payment.id,
      qboType: 'Payment',
      qboId: 'qbo-pay-1',
      state: 'synced',
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Payment',
        entity: paymentEntity({ operation: 'Void' }),
        refetched: paymentEnvelope(),
      }),
    );

    expect(result).toEqual({ action: 'voided', localId: payment.id });
    const [updatedPayment] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, payment.id));
    expect(updatedPayment?.status).toBe('void');

    const applications = await testDb.db
      .select()
      .from(paymentApplications)
      .where(eq(paymentApplications.paymentTxnId, payment.id));
    expect(applications).toHaveLength(0);

    const [updatedInvoice] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(updatedInvoice?.status).toBe('open');
    expect(updatedInvoice?.balance).toBe('100.00');
  });

  it('linked + Delete: soft-deletes the payment (deletedAt, status untouched), removes its application, and restores the invoice balance — distinct from Void', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const { invoice, payment } = await seedPaidInvoice(seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: payment.id,
      qboType: 'Payment',
      qboId: 'qbo-pay-1',
      state: 'synced',
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Payment',
        entity: paymentEntity({ operation: 'Delete' }),
        refetched: paymentEnvelope(),
      }),
    );

    expect(result).toEqual({ action: 'deleted', localId: payment.id });
    const [updatedPayment] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, payment.id));
    // Deleted, not voided: status is left as 'paid' (deletedAt is orthogonal to status), but
    // deletedAt is now set.
    expect(updatedPayment?.status).toBe('paid');
    expect(updatedPayment?.deletedAt).not.toBeNull();

    const applications = await testDb.db
      .select()
      .from(paymentApplications)
      .where(eq(paymentApplications.paymentTxnId, payment.id));
    expect(applications).toHaveLength(0);

    const [updatedInvoice] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(updatedInvoice?.status).toBe('open');
    expect(updatedInvoice?.balance).toBe('100.00');

    const audits = await auditsFor(testDb.db, seed.orgId);
    expect(audits.some((a) => a.action === 'qbo.inbound.delete' && a.outcome === 'success')).toBe(
      true,
    );
  });

  it('unlinked Payment is always skipped — no natural-key matcher exists for Payment', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedPaidInvoice(seed);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Payment',
        entity: paymentEntity(),
        refetched: paymentEnvelope(),
      }),
    );
    expect(result).toEqual({ action: 'unmatched', reason: 'no_payment_natural_key_matcher' });
    const links = await testDb.db.select().from(syncLinks).where(eq(syncLinks.orgId, seed.orgId));
    expect(links).toHaveLength(0);
  });

  it('a stale Payment Update (lower SyncToken than already applied) is skipped — persisted memo UNCHANGED', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const { payment } = await seedPaidInvoice(seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: payment.id,
      qboType: 'Payment',
      qboId: 'qbo-pay-1',
      state: 'synced',
      qboSyncToken: '3',
      lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Payment',
        entity: paymentEntity(),
        refetched: paymentEnvelope({ SyncToken: '1', PrivateNote: 'should-not-land' }),
      }),
    );
    expect(result).toEqual({ action: 'skipped', localId: payment.id, reason: 'stale_ignored' });

    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, payment.id));
    expect(row?.memo).toBeNull();

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', payment.id);
    expect(link?.qboSyncToken).toBe('3');
  });

  it('a stale Payment Delete (lower SyncToken than already applied) is skipped — never soft-deletes, application stays intact', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const { invoice, payment } = await seedPaidInvoice(seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: payment.id,
      qboType: 'Payment',
      qboId: 'qbo-pay-1',
      state: 'synced',
      qboSyncToken: '3',
      lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Payment',
        entity: paymentEntity({ operation: 'Delete' }),
        refetched: paymentEnvelope({ SyncToken: '1' }),
      }),
    );
    expect(result).toEqual({ action: 'skipped', localId: payment.id, reason: 'stale_ignored' });

    // Anti-tautology: a broken guard would soft-delete + remove the application + recompute the
    // invoice here — all three would then fail.
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, payment.id));
    expect(row?.deletedAt).toBeNull();
    expect(row?.status).toBe('paid');

    const applications = await testDb.db
      .select()
      .from(paymentApplications)
      .where(eq(paymentApplications.paymentTxnId, payment.id));
    expect(applications).toHaveLength(1);

    const [invoiceRow] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(invoiceRow?.status).toBe('paid');

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', payment.id);
    expect(link?.qboSyncToken).toBe('3');
  });
});

describe('applyInboundEntity — Payment both-sides-changed conflict (20010)', () => {
  async function seedLinkedPayment(seed: Awaited<ReturnType<typeof seedOrg>>) {
    const db = testDb?.db as TestDb['db'];
    const invoice = await seedInvoice(db, seed);
    const { payment } = await recordPayment(
      db,
      { orgId: seed.orgId, userId: seed.userId },
      invoice.id,
      { amount: '100.00', txnDate: '2026-01-05' },
    );
    await upsertLink(db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: payment.id,
      qboType: 'Payment',
      qboId: 'qbo-pay-1',
      state: 'synced',
      localVersion: payment.version,
      qboSyncToken: '1',
      lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    });
    return { invoice, payment };
  }

  async function dirtyLocally(id: string, currentVersion: number) {
    await (testDb?.db as TestDb['db'])
      .update(transactions)
      .set({ version: currentVersion + 1, memo: 'local edit' })
      .where(eq(transactions.id, id));
  }

  it('linked + Update: local dirty AND incoming genuinely newer -> conflict, NO mutation', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const { payment } = await seedLinkedPayment(seed);
    await dirtyLocally(payment.id, payment.version);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Payment',
        entity: paymentEntity(),
        refetched: paymentEnvelope({ SyncToken: '2', PrivateNote: 'should-not-land' }),
      }),
    );

    expect(result).toEqual({
      action: 'conflict',
      localId: payment.id,
      reason: 'both_sides_changed',
    });
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, payment.id));
    expect(row?.memo).toBe('local edit');

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', payment.id);
    expect(link?.state).toBe('conflict');
    expect(link?.conflictDetectedAt).not.toBeNull();
    expect(link?.qboSyncToken).toBe('1');
  });

  it('linked + Void (voided-in-both): local dirty + genuinely-newer inbound Void -> conflict, application intact, invoice balance untouched', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const { invoice, payment } = await seedLinkedPayment(seed);
    await dirtyLocally(payment.id, payment.version);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Payment',
        entity: paymentEntity({ operation: 'Void' }),
        refetched: paymentEnvelope({ SyncToken: '2' }),
      }),
    );

    expect(result).toEqual({
      action: 'conflict',
      localId: payment.id,
      reason: 'both_sides_changed',
    });

    const [paymentRow] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, payment.id));
    expect(paymentRow?.status).not.toBe('void');

    const applications = await testDb.db
      .select()
      .from(paymentApplications)
      .where(eq(paymentApplications.paymentTxnId, payment.id));
    expect(applications).toHaveLength(1);

    const [invoiceRow] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(invoiceRow?.status).toBe('paid');
  });

  it('linked + Delete: both-sides-changed -> conflict, never soft-deletes over a local edit', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const { payment } = await seedLinkedPayment(seed);
    await dirtyLocally(payment.id, payment.version);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Payment',
        entity: paymentEntity({ operation: 'Delete' }),
        refetched: paymentEnvelope({ SyncToken: '2' }),
      }),
    );

    expect(result).toEqual({
      action: 'conflict',
      localId: payment.id,
      reason: 'both_sides_changed',
    });
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, payment.id));
    expect(row?.deletedAt).toBeNull();

    const applications = await testDb.db
      .select()
      .from(paymentApplications)
      .where(eq(paymentApplications.paymentTxnId, payment.id));
    expect(applications).toHaveLength(1);
  });
});

describe('applyInboundEntity — Customer (linking only)', () => {
  it('linked + Update: refreshes the SyncToken, does not patch contact content', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'contact',
      localId: seed.contact.id,
      qboType: 'Customer',
      qboId: 'qbo-cust-1',
      state: 'synced',
      qboSyncToken: '0',
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Customer',
        entity: customerEntity(),
        refetched: customerEnvelope({ DisplayName: 'Renamed In QBO' }),
      }),
    );

    expect(result).toEqual({ action: 'updated', localId: seed.contact.id });
    const [contact] = await testDb.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, seed.contact.id));
    // Content sync for Customer is out of scope here (linking-only) — the name must NOT change.
    expect(contact?.displayName).toBe('Acme Co');
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'contact', seed.contact.id);
    expect(link?.qboSyncToken).toBe('2');
  });

  it('linked + Void: no local void state for a contact — documented skip', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'contact',
      localId: seed.contact.id,
      qboType: 'Customer',
      qboId: 'qbo-cust-1',
      state: 'synced',
    });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Customer',
        entity: customerEntity({ operation: 'Void' }),
        refetched: customerEnvelope(),
      }),
    );
    expect(result).toEqual({
      action: 'skipped',
      localId: seed.contact.id,
      reason: 'contact_void_not_supported',
    });
  });

  it('unlinked + email match: links (synced), no content applied', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Customer',
        entity: customerEntity(),
        refetched: customerEnvelope({ PrimaryEmailAddr: { Address: 'acme@example.test' } }),
      }),
    );

    expect(result).toEqual({ action: 'linked', localId: seed.contact.id });
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'contact', seed.contact.id);
    expect(link).toMatchObject({ state: 'synced', qboType: 'Customer', qboId: 'qbo-cust-1' });
  });

  it('unlinked + no match: skipped, no link', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Customer',
        entity: customerEntity(),
        refetched: customerEnvelope({ PrimaryEmailAddr: { Address: 'nobody@example.test' } }),
      }),
    );
    expect(result).toEqual({ action: 'unmatched', reason: 'no_match' });
    const links = await testDb.db.select().from(syncLinks).where(eq(syncLinks.orgId, seed.orgId));
    expect(links).toHaveLength(0);
  });
});

describe('applyInboundEntity — Merge/Emailed no-op and unsupported entity types', () => {
  it('Merge is a no-op regardless of link state', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ entity: invoiceEntity({ operation: 'Merge' }) }),
      }),
    );
    expect(result).toEqual({ action: 'skipped', reason: 'operation_not_applied:Merge' });
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.docNumber).toBe('INV-1');
  });

  it('Emailed is a no-op', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedInvoice(testDb.db, seed);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ entity: invoiceEntity({ operation: 'Emailed' }) }),
      }),
    );
    expect(result).toEqual({ action: 'skipped', reason: 'operation_not_applied:Emailed' });
  });

  it('Account/Item entity types are skipped-audit — apply is scoped to Invoice/Payment/Customer', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Account',
        entity: { name: 'Account', id: 'qbo-acct-1', operation: 'Update' },
        refetched: { Account: { Id: 'qbo-acct-1' } },
      }),
    );
    expect(result).toEqual({ action: 'skipped', reason: 'entity_type_not_applied:Account' });
  });
});

// ---------------------------------------------------------------------------
// Atomicity + idempotency: proving `recordEventIfNew` and `applyInboundEntity` share ONE tx.
// This is the correctness fix carried from 20005's review (§0a.1) — a crash between claiming
// and finishing the apply must roll back the claim too, so redelivery re-drives the event.
// ---------------------------------------------------------------------------

describe('claim + apply atomicity (recordEventIfNew + applyInboundEntity in one tx)', () => {
  async function claimAndApply(
    seed: Awaited<ReturnType<typeof seedOrg>>,
    entity: WebhookEntity,
    refetched: QboEntityEnvelope,
    forceThrowAfterApply = false,
  ) {
    return (testDb as TestDb).db.transaction(async (tx) => {
      const isNew = await recordEventIfNew(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        name: entity.name,
        id: entity.id,
        operation: entity.operation,
        lastUpdated: entity.lastUpdated,
      });
      if (!isNew) return { isNew, result: undefined };
      const result = await applyInboundEntity(tx, {
        orgId: seed.orgId,
        realmId: 'realm-1',
        entityType: 'Invoice',
        entity,
        refetched,
      });
      if (forceThrowAfterApply) throw new Error('forced mid-apply throw (simulated crash)');
      return { isNew, result };
    });
  }

  it('success: both the dedup claim and the apply commit together', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
    });

    const outcome = await claimAndApply(
      seed,
      invoiceEntity(),
      invoiceEnvelope({ PrivateNote: 'committed' }),
    );
    expect(outcome.isNew).toBe(true);
    expect(outcome.result?.action).toBe('updated');

    const events = await testDb.db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.orgId, seed.orgId));
    expect(events).toHaveLength(1);
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.memo).toBe('committed');
  });

  it('rollback: a throw after a successful apply rolls back BOTH the apply and the dedup claim', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
    });

    await expect(
      claimAndApply(
        seed,
        invoiceEntity(),
        invoiceEnvelope({ PrivateNote: 'should be rolled back' }),
        true,
      ),
    ).rejects.toThrow('forced mid-apply throw');

    // Anti-tautology: without the shared tx, the claim would have committed independently and
    // this would be 1, not 0.
    const events = await testDb.db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.orgId, seed.orgId));
    expect(events).toHaveLength(0);
    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    expect(row?.memo).toBeNull();

    const audits = await auditsFor(testDb.db, seed.orgId);
    expect(audits).toHaveLength(0);
  });

  it('idempotent redelivery: a second claim+apply for the same event is a no-op (local record unchanged)', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'synced',
    });

    const entity = invoiceEntity({ lastUpdated: '2026-01-05T00:00:00Z' });
    const first = await claimAndApply(
      seed,
      entity,
      invoiceEnvelope({ PrivateNote: 'first apply' }),
    );
    expect(first.isNew).toBe(true);

    const second = await claimAndApply(
      seed,
      entity,
      invoiceEnvelope({ PrivateNote: 'should not land' }),
    );
    expect(second.isNew).toBe(false);
    expect(second.result).toBeUndefined();

    const [row] = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, invoice.id));
    // Anti-tautology: this asserts the actual persisted content, not merely `isNew === false`.
    expect(row?.memo).toBe('first apply');

    const events = await testDb.db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.orgId, seed.orgId));
    expect(events).toHaveLength(1);
  });
});
