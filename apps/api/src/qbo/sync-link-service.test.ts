import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import { accounts, contacts, items, transactionLines, transactions } from '../db/schema.ts';
import { ConflictingLinkError, UnmappableEntityError } from './errors.ts';
import { MAX_RETRY_ATTEMPTS } from './retry.ts';
import {
  findFailedLinksDue,
  findFailedLinksForOrg,
  findLinkById,
  findLinkByLocal,
  findLinkByQbo,
  markConflict,
  markFailed,
  markSynced,
  resolveQboType,
  resolveTransactionDeps,
  setLinkState,
  upsertLink,
} from './sync-link-service.ts';

let testDb: TestDb | undefined;

afterEach(async () => {
  await testDb?.cleanup();
  testDb = undefined;
});

describe('resolveQboType', () => {
  it('maps reference-data entity types directly', () => {
    expect(resolveQboType('contact')).toBe('Customer');
    expect(resolveQboType('account')).toBe('Account');
    expect(resolveQboType('item')).toBe('Item');
  });

  it('splits transaction on txnType: customer_invoice -> Invoice, payment -> Payment', () => {
    expect(resolveQboType('transaction', 'customer_invoice')).toBe('Invoice');
    expect(resolveQboType('transaction', 'payment')).toBe('Payment');
  });

  it('throws UnmappableEntityError for a transaction with no txnType', () => {
    expect(() => resolveQboType('transaction')).toThrow(UnmappableEntityError);
  });

  it('throws UnmappableEntityError for an unsupported transaction type', () => {
    expect(() => resolveQboType('transaction', 'journal_entry')).toThrow(UnmappableEntityError);
    expect(() => resolveQboType('transaction', 'vendor_bill')).toThrow(UnmappableEntityError);
  });
});

describe('upsertLink', () => {
  it('inserts a new link when none exists', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const [contact] = await testDb.db
      .insert(contacts)
      .values({ orgId, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contact) throw new Error('setup: contact insert returned no row');

    const link = await upsertLink(testDb.db, {
      orgId,
      entityType: 'contact',
      localId: contact.id,
      qboType: 'Customer',
      qboId: 'qbo-1',
    });

    expect(link.state).toBe('pending');
    expect(link.qboId).toBe('qbo-1');
  });

  it('is idempotent: linking the same local<->qbo pair twice results in one row', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const [contact] = await testDb.db
      .insert(contacts)
      .values({ orgId, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contact) throw new Error('setup: contact insert returned no row');

    const first = await upsertLink(testDb.db, {
      orgId,
      entityType: 'contact',
      localId: contact.id,
      qboType: 'Customer',
      qboId: 'qbo-1',
    });
    const second = await upsertLink(testDb.db, {
      orgId,
      entityType: 'contact',
      localId: contact.id,
      qboType: 'Customer',
      qboId: 'qbo-1',
      state: 'synced',
    });

    expect(second.id).toBe(first.id);
    expect(second.state).toBe('synced');

    const found = await findLinkByLocal(testDb.db, orgId, 'contact', contact.id);
    expect(found?.id).toBe(first.id);
  });

  it('updates state/version/token on the idempotent path without touching unspecified fields', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const [contact] = await testDb.db
      .insert(contacts)
      .values({ orgId, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contact) throw new Error('setup: contact insert returned no row');

    await upsertLink(testDb.db, {
      orgId,
      entityType: 'contact',
      localId: contact.id,
      qboType: 'Customer',
      qboId: 'qbo-1',
      localVersion: 1,
    });
    const updated = await upsertLink(testDb.db, {
      orgId,
      entityType: 'contact',
      localId: contact.id,
      qboType: 'Customer',
      qboId: 'qbo-1',
      state: 'synced',
      qboSyncToken: '3',
    });

    expect(updated.state).toBe('synced');
    expect(updated.qboSyncToken).toBe('3');
    // localVersion wasn't passed on the second call, so the first call's value is preserved.
    expect(updated.localVersion).toBe(1);
  });

  it('throws ConflictingLinkError when the local is already linked to a different qboId', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const [contact] = await testDb.db
      .insert(contacts)
      .values({ orgId, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contact) throw new Error('setup: contact insert returned no row');

    await upsertLink(testDb.db, {
      orgId,
      entityType: 'contact',
      localId: contact.id,
      qboType: 'Customer',
      qboId: 'qbo-1',
    });

    await expect(
      upsertLink(testDb.db, {
        orgId,
        entityType: 'contact',
        localId: contact.id,
        qboType: 'Customer',
        qboId: 'qbo-2',
      }),
    ).rejects.toThrow(ConflictingLinkError);
  });

  it('throws ConflictingLinkError when the qboId is already linked to a different local record', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const [contactA, contactB] = await testDb.db
      .insert(contacts)
      .values([
        { orgId, displayName: 'Acme Co', isCustomer: true },
        { orgId, displayName: 'Beta Co', isCustomer: true },
      ])
      .returning();
    if (!contactA || !contactB) throw new Error('setup: contact insert returned fewer rows');

    await upsertLink(testDb.db, {
      orgId,
      entityType: 'contact',
      localId: contactA.id,
      qboType: 'Customer',
      qboId: 'qbo-shared',
    });

    await expect(
      upsertLink(testDb.db, {
        orgId,
        entityType: 'contact',
        localId: contactB.id,
        qboType: 'Customer',
        qboId: 'qbo-shared',
      }),
    ).rejects.toThrow(ConflictingLinkError);
  });

  it('does not leak links across orgs', async () => {
    testDb = await createTestDb();
    const { orgId: orgA } = await seedBaseOrg(testDb.db, { name: 'Org A' });
    const { orgId: orgB } = await seedBaseOrg(testDb.db, { name: 'Org B' });
    const [contactA] = await testDb.db
      .insert(contacts)
      .values({ orgId: orgA, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contactA) throw new Error('setup: contact insert returned no row');

    await upsertLink(testDb.db, {
      orgId: orgA,
      entityType: 'contact',
      localId: contactA.id,
      qboType: 'Customer',
      qboId: 'qbo-1',
    });

    expect(await findLinkByLocal(testDb.db, orgB, 'contact', contactA.id)).toBeNull();
    expect(await findLinkByQbo(testDb.db, orgB, 'Customer', 'qbo-1')).toBeNull();
    expect(await findLinkByQbo(testDb.db, orgA, 'Customer', 'qbo-1')).not.toBeNull();
  });
});

describe('findLinkByLocal / findLinkByQbo', () => {
  it('return null when no row matches', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    expect(await findLinkByLocal(testDb.db, orgId, 'contact', crypto.randomUUID())).toBeNull();
    expect(await findLinkByQbo(testDb.db, orgId, 'Customer', 'nope')).toBeNull();
  });
});

describe('findLinkById (20010)', () => {
  it('finds a link by its own id, org-scoped', async () => {
    testDb = await createTestDb();
    const { orgId: orgA } = await seedBaseOrg(testDb.db, { name: 'Org A' });
    const { orgId: orgB } = await seedBaseOrg(testDb.db, { name: 'Org B' });
    const [contact] = await testDb.db
      .insert(contacts)
      .values({ orgId: orgA, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contact) throw new Error('setup: contact insert returned no row');

    const link = await upsertLink(testDb.db, {
      orgId: orgA,
      entityType: 'contact',
      localId: contact.id,
      qboType: 'Customer',
      qboId: 'qbo-1',
    });

    expect((await findLinkById(testDb.db, orgA, link.id))?.id).toBe(link.id);
    // Cross-org lookup of a real linkId is invisible, not a leak.
    expect(await findLinkById(testDb.db, orgB, link.id)).toBeNull();
    expect(await findLinkById(testDb.db, orgA, crypto.randomUUID())).toBeNull();
  });
});

async function seedLink(db: TestDb['db'], orgId: string) {
  const [contact] = await db
    .insert(contacts)
    .values({ orgId, displayName: 'Acme Co', isCustomer: true })
    .returning();
  if (!contact) throw new Error('setup: contact insert returned no row');
  const link = await upsertLink(db, {
    orgId,
    entityType: 'contact',
    localId: contact.id,
    qboType: 'Customer',
    qboId: 'qbo-1',
  });
  return { contactId: contact.id, link };
}

describe('setLinkState / markSynced / markConflict / markFailed', () => {
  it('setLinkState writes the given state', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const { contactId } = await seedLink(testDb.db, orgId);

    const updated = await setLinkState(testDb.db, orgId, 'contact', contactId, 'failed');
    expect(updated?.state).toBe('failed');
  });

  it('markSynced sets state=synced, stamps lastSyncedAt, and only touches passed fields', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const { contactId } = await seedLink(testDb.db, orgId);

    const updated = await markSynced(testDb.db, orgId, 'contact', contactId, {
      qboSyncToken: '5',
      localVersion: 2,
    });
    expect(updated?.state).toBe('synced');
    expect(updated?.qboSyncToken).toBe('5');
    expect(updated?.localVersion).toBe(2);
    expect(updated?.lastSyncedAt).not.toBeNull();
  });

  it('markConflict sets state=conflict and stamps conflictDetectedAt (20010)', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const { contactId } = await seedLink(testDb.db, orgId);

    const updated = await markConflict(testDb.db, orgId, 'contact', contactId);
    expect(updated?.state).toBe('conflict');
    expect(updated?.conflictDetectedAt).not.toBeNull();
  });

  it('markSynced clears conflictDetectedAt (20010)', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const { contactId } = await seedLink(testDb.db, orgId);

    await markConflict(testDb.db, orgId, 'contact', contactId);
    const resynced = await markSynced(testDb.db, orgId, 'contact', contactId, {
      qboSyncToken: '9',
    });
    expect(resynced?.state).toBe('synced');
    expect(resynced?.conflictDetectedAt).toBeNull();
  });

  it('markFailed sets state=failed and stamps retry bookkeeping', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const { contactId } = await seedLink(testDb.db, orgId);

    const updated = await markFailed(testDb.db, orgId, 'contact', contactId, 'Customer', 'boom');
    expect(updated?.state).toBe('failed');
    expect(updated?.retryCount).toBe(1);
    expect(updated?.nextRetryAt).not.toBeNull();
    expect(updated?.lastError).toBe('boom');
  });
});

describe('markFailed (20011 upsert / retry-queue semantics)', () => {
  it('seeds a brand-new failed link (qboId null) when none exists yet — the first-ever-failure gap fix', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const [contact] = await testDb.db
      .insert(contacts)
      .values({ orgId, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contact) throw new Error('setup: contact insert returned no row');

    expect(await findLinkByLocal(testDb.db, orgId, 'contact', contact.id)).toBeNull();

    const created = await markFailed(
      testDb.db,
      orgId,
      'contact',
      contact.id,
      'Customer',
      'first failure',
    );
    expect(created?.state).toBe('failed');
    expect(created?.qboId).toBeNull();
    expect(created?.retryCount).toBe(1);
    expect(created?.nextRetryAt).not.toBeNull();
    expect(created?.lastError).toBe('first failure');
  });

  it('increments retryCount and pushes nextRetryAt out on a repeat failure', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const [contact] = await testDb.db
      .insert(contacts)
      .values({ orgId, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contact) throw new Error('setup: contact insert returned no row');

    const first = await markFailed(testDb.db, orgId, 'contact', contact.id, 'Customer', 'e1');
    const second = await markFailed(testDb.db, orgId, 'contact', contact.id, 'Customer', 'e2');

    expect(second?.retryCount).toBe(2);
    expect(second?.lastError).toBe('e2');
    expect(first?.nextRetryAt).not.toBeNull();
    expect(second?.nextRetryAt).not.toBeNull();
    expect(second?.nextRetryAt?.getTime()).toBeGreaterThan(first?.nextRetryAt?.getTime() ?? 0);
  });

  it('goes terminal (nextRetryAt=null, stays failed) once MAX_RETRY_ATTEMPTS is reached', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const [contact] = await testDb.db
      .insert(contacts)
      .values({ orgId, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contact) throw new Error('setup: contact insert returned no row');

    let last = await markFailed(testDb.db, orgId, 'contact', contact.id, 'Customer', 'e');
    for (let i = 1; i < MAX_RETRY_ATTEMPTS; i++) {
      last = await markFailed(testDb.db, orgId, 'contact', contact.id, 'Customer', 'e');
    }

    expect(last?.retryCount).toBe(MAX_RETRY_ATTEMPTS);
    expect(last?.state).toBe('failed');
    expect(last?.nextRetryAt).toBeNull();
  });

  it('never demotes a conflict link — is a no-op that returns it unchanged', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const { contactId } = await seedLink(testDb.db, orgId);
    await markConflict(testDb.db, orgId, 'contact', contactId);

    const result = await markFailed(
      testDb.db,
      orgId,
      'contact',
      contactId,
      'Customer',
      'should not apply',
    );
    expect(result?.state).toBe('conflict');
    expect(result?.lastError).toBeNull();
  });
});

describe('markSynced clears 20011 retry bookkeeping', () => {
  it('clears retryCount/nextRetryAt/lastError on a successful sync', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const { contactId } = await seedLink(testDb.db, orgId);

    await markFailed(testDb.db, orgId, 'contact', contactId, 'Customer', 'boom');
    const resynced = await markSynced(testDb.db, orgId, 'contact', contactId, {
      qboSyncToken: '1',
    });

    expect(resynced?.state).toBe('synced');
    expect(resynced?.retryCount).toBe(0);
    expect(resynced?.nextRetryAt).toBeNull();
    expect(resynced?.lastError).toBeNull();
  });
});

describe('upsertLink assigns a qboId for the first time on an existing null-qboId link (20011)', () => {
  it('does not throw ConflictingLinkError when linking a previously-unlinked failed row', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const [contact] = await testDb.db
      .insert(contacts)
      .values({ orgId, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contact) throw new Error('setup: contact insert returned no row');

    const failed = await markFailed(testDb.db, orgId, 'contact', contact.id, 'Customer', 'e');
    expect(failed?.qboId).toBeNull();

    const linked = await upsertLink(testDb.db, {
      orgId,
      entityType: 'contact',
      localId: contact.id,
      qboType: 'Customer',
      qboId: 'qbo-reconciled-1',
      state: 'synced',
    });

    expect(linked.id).toBe(failed?.id);
    expect(linked.qboId).toBe('qbo-reconciled-1');
    expect(linked.state).toBe('synced');
  });

  it('still refuses to steal a qboId already claimed by a different local record', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const [contactA, contactB] = await testDb.db
      .insert(contacts)
      .values([
        { orgId, displayName: 'Acme Co', isCustomer: true },
        { orgId, displayName: 'Beta Co', isCustomer: true },
      ])
      .returning();
    if (!contactA || !contactB) throw new Error('setup: contact insert returned fewer rows');

    await upsertLink(testDb.db, {
      orgId,
      entityType: 'contact',
      localId: contactA.id,
      qboType: 'Customer',
      qboId: 'qbo-shared',
    });
    await markFailed(testDb.db, orgId, 'contact', contactB.id, 'Customer', 'e');

    await expect(
      upsertLink(testDb.db, {
        orgId,
        entityType: 'contact',
        localId: contactB.id,
        qboType: 'Customer',
        qboId: 'qbo-shared',
      }),
    ).rejects.toThrow(ConflictingLinkError);
  });
});

describe('findFailedLinksDue / findFailedLinksForOrg', () => {
  it('findFailedLinksDue only returns failed links whose nextRetryAt has elapsed, cross-org', async () => {
    testDb = await createTestDb();
    const { orgId: orgA } = await seedBaseOrg(testDb.db, { name: 'Org A' });
    const { orgId: orgB } = await seedBaseOrg(testDb.db, { name: 'Org B' });
    const [contactA] = await testDb.db
      .insert(contacts)
      .values({ orgId: orgA, displayName: 'Acme Co', isCustomer: true })
      .returning();
    const [contactB] = await testDb.db
      .insert(contacts)
      .values({ orgId: orgB, displayName: 'Beta Co', isCustomer: true })
      .returning();
    if (!contactA || !contactB) throw new Error('setup: contact insert returned no row');

    const due = await markFailed(testDb.db, orgA, 'contact', contactA.id, 'Customer', 'e');
    await markFailed(testDb.db, orgB, 'contact', contactB.id, 'Customer', 'e');

    // Not-yet-due: nextRetryAt is in the future relative to `now` passed below.
    const now = new Date((due?.nextRetryAt?.getTime() ?? 0) + 1);
    const results = await findFailedLinksDue(testDb.db, now);

    expect(results.map((r) => r.id)).toEqual(expect.arrayContaining([due?.id]));
    // The immediate `now` (before backoff elapses) finds nothing.
    expect(await findFailedLinksDue(testDb.db, new Date(0))).toEqual([]);
  });

  it('findFailedLinksForOrg is org-scoped and includes terminal (nextRetryAt=null) links', async () => {
    testDb = await createTestDb();
    const { orgId: orgA } = await seedBaseOrg(testDb.db, { name: 'Org A' });
    const { orgId: orgB } = await seedBaseOrg(testDb.db, { name: 'Org B' });
    const [contactA] = await testDb.db
      .insert(contacts)
      .values({ orgId: orgA, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contactA) throw new Error('setup: contact insert returned no row');

    let last = await markFailed(testDb.db, orgA, 'contact', contactA.id, 'Customer', 'e');
    for (let i = 1; i < MAX_RETRY_ATTEMPTS; i++) {
      last = await markFailed(testDb.db, orgA, 'contact', contactA.id, 'Customer', 'e');
    }
    expect(last?.nextRetryAt).toBeNull(); // terminal

    const resultsA = await findFailedLinksForOrg(testDb.db, orgA);
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0]?.id).toBe(last?.id);

    const resultsB = await findFailedLinksForOrg(testDb.db, orgB);
    expect(resultsB).toEqual([]);
  });
});

describe('resolveTransactionDeps', () => {
  async function seedInvoiceTxn(db: TestDb['db'], orgId: string) {
    const [contact] = await db
      .insert(contacts)
      .values({ orgId, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contact) throw new Error('setup: contact insert returned no row');

    const [arAccount, incomeAccount] = await db
      .insert(accounts)
      .values([
        { orgId, name: 'Accounts Receivable', type: 'asset' },
        { orgId, name: 'Sales Income', type: 'income' },
      ])
      .returning();
    if (!arAccount || !incomeAccount) throw new Error('setup: account insert returned fewer rows');

    const [item] = await db
      .insert(items)
      .values({ orgId, name: 'Consulting', kind: 'service' })
      .returning();
    if (!item) throw new Error('setup: item insert returned no row');

    const [txn] = await db
      .insert(transactions)
      .values({
        orgId,
        type: 'customer_invoice',
        status: 'open',
        contactId: contact.id,
        txnDate: '2026-01-01',
        subtotal: '100.00',
        total: '100.00',
        balance: '100.00',
      })
      .returning();
    if (!txn) throw new Error('setup: transaction insert returned no row');

    await db.insert(transactionLines).values({
      orgId,
      transactionId: txn.id,
      lineNumber: 1,
      itemId: item.id,
      accountId: incomeAccount.id,
      quantity: '1',
      unitPrice: '100.00',
      amount: '100.00',
    });

    return { contact, arAccount, incomeAccount, item, txn };
  }

  it('allLinked=false and lists exactly the unlinked refs when only the contact is linked', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const { contact, incomeAccount, item, txn } = await seedInvoiceTxn(testDb.db, orgId);

    await upsertLink(testDb.db, {
      orgId,
      entityType: 'contact',
      localId: contact.id,
      qboType: 'Customer',
      qboId: 'qbo-customer-1',
    });

    const deps = await resolveTransactionDeps(testDb.db, orgId, txn.id);

    expect(deps.allLinked).toBe(false);
    expect(deps.contact?.link).not.toBeNull();
    expect(deps.unlinked).toEqual(
      expect.arrayContaining([
        { entityType: 'account', localId: incomeAccount.id },
        { entityType: 'item', localId: item.id },
      ]),
    );
    expect(deps.unlinked).toHaveLength(2);
  });

  it('allLinked=true once the contact, every line account, and every line item are linked', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const { contact, incomeAccount, item, txn } = await seedInvoiceTxn(testDb.db, orgId);

    await upsertLink(testDb.db, {
      orgId,
      entityType: 'contact',
      localId: contact.id,
      qboType: 'Customer',
      qboId: 'qbo-customer-1',
    });
    await upsertLink(testDb.db, {
      orgId,
      entityType: 'account',
      localId: incomeAccount.id,
      qboType: 'Account',
      qboId: 'qbo-account-1',
    });
    await upsertLink(testDb.db, {
      orgId,
      entityType: 'item',
      localId: item.id,
      qboType: 'Item',
      qboId: 'qbo-item-1',
    });

    const deps = await resolveTransactionDeps(testDb.db, orgId, txn.id);

    expect(deps.allLinked).toBe(true);
    expect(deps.unlinked).toEqual([]);
  });

  it('throws for a transaction that does not exist in the org', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    await expect(resolveTransactionDeps(testDb.db, orgId, crypto.randomUUID())).rejects.toThrow();
  });
});
