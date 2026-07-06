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
import { createInvoice } from '../invoices/service.ts';
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
import { findLinkByLocal, upsertLink } from './sync-link-service.ts';
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

  it('linked + Delete also maps to a local void (delete-vs-void split is 20009)', async () => {
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
    expect(result.action).toBe('voided');
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

  it('unlinked + zero matching candidates (none): skipped, no link', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedInvoice(testDb.db, seed, { docNumber: 'INV-1' });

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({ refetched: invoiceEnvelope({ DocNumber: 'NO-MATCH' }) }),
      }),
    );
    expect(result).toEqual({ action: 'unmatched', reason: 'no_match' });
  });

  it('a Create with no natural-key match is deferred (documented), not auto-created', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);

    const result = await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: seed.orgId,
        ...baseInput({
          entity: invoiceEntity({ operation: 'Create' }),
          refetched: invoiceEnvelope({ DocNumber: 'BRAND-NEW' }),
        }),
      }),
    );
    expect(result).toEqual({ action: 'unmatched', reason: 'no_match:create_deferred' });
    const rows = await testDb.db
      .select()
      .from(transactions)
      .where(eq(transactions.orgId, seed.orgId));
    expect(rows).toHaveLength(0);
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
