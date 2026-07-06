import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import { accounts, contacts, items, transactionLines, transactions } from '../db/schema.ts';
import { ConflictingLinkError, UnmappableEntityError } from './errors.ts';
import {
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

describe('setLinkState / markSynced / markConflict / markFailed', () => {
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

  it('markConflict sets state=conflict', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const { contactId } = await seedLink(testDb.db, orgId);

    const updated = await markConflict(testDb.db, orgId, 'contact', contactId);
    expect(updated?.state).toBe('conflict');
  });

  it('markFailed sets state=failed', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const { contactId } = await seedLink(testDb.db, orgId);

    const updated = await markFailed(testDb.db, orgId, 'contact', contactId);
    expect(updated?.state).toBe('failed');
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
