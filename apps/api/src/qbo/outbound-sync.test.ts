import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFakeQboWriteClient,
  type FakeQboWriteClient,
} from '../__tests__/helpers/fake-qbo-write-client.ts';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import { getContact } from '../contacts/service.ts';
import { accounts, contacts, items, syncAuditLogs, syncLinks, users } from '../db/schema.ts';
import { createInvoice, updateInvoice, voidInvoice } from '../invoices/service.ts';
import { recordPayment, voidPayment } from '../payments/service.ts';
import {
  type OutboundDeps,
  resolveOutboundDeps,
  syncInvoiceOutbound,
  syncPaymentOutbound,
} from './outbound-sync.ts';
import { findLinkByLocal, upsertLink } from './sync-link-service.ts';

let testDb: TestDb | undefined;

afterEach(async () => {
  await testDb?.cleanup();
  testDb = undefined;
});

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
  overrides: { unitPrice?: string; quantity?: number } = {},
) {
  return createInvoice(
    db,
    { orgId: seed.orgId, userId: seed.userId },
    {
      contactId: seed.contact.id,
      txnDate: '2026-01-01',
      docNumber: 'INV-1',
      lines: [
        {
          itemId: seed.item.id,
          quantity: overrides.quantity ?? 2,
          unitPrice: overrides.unitPrice ?? '50.00',
        },
      ],
    },
  );
}

function deps(client: FakeQboWriteClient): OutboundDeps {
  return { client, realmId: 'realm-1', accessToken: 'access-1' };
}

describe('syncInvoiceOutbound', () => {
  it('pushes refs (Customer/Account/Item) before the Invoice, and marks the link synced', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    const client = createFakeQboWriteClient();

    const result = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });

    expect(result.status).toBe('synced');
    expect(result.qboId).toBeTruthy();
    expect(client.countOf('create', 'Customer')).toBe(1);
    expect(client.countOf('create', 'Account')).toBe(1);
    expect(client.countOf('create', 'Item')).toBe(1);
    expect(client.countOf('create', 'Invoice')).toBe(1);

    // Refs were pushed before the document.
    const invoiceCallIndex = client.calls.findIndex(
      (c) => c.method === 'create' && c.entityType === 'Invoice',
    );
    const refCallIndexes = client.calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.method === 'create' && c.entityType !== 'Invoice')
      .map(({ i }) => i);
    expect(refCallIndexes.every((i) => i < invoiceCallIndex)).toBe(true);

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('synced');
    expect(link?.qboType).toBe('Invoice');
    expect(link?.qboSyncToken).toBe('0');
    expect(link?.localVersion).toBe(invoice.version);

    const audits = await testDb.db
      .select()
      .from(syncAuditLogs)
      .where(and(eq(syncAuditLogs.orgId, seed.orgId), eq(syncAuditLogs.localId, invoice.id)));
    expect(audits.some((a) => a.direction === 'outbound' && a.outcome === 'success')).toBe(true);
  });

  it('is idempotent: re-pushing the same invoice never re-creates (create count stays 1)', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    const client = createFakeQboWriteClient();

    await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });
    const second = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });

    // 20008 outbound redundant-write guard (§0a.4): re-pushing an invoice whose local `version`
    // hasn't advanced past what was already pushed is a no-op skip, not a redundant sparse
    // UPDATE. Anti-tautology: removing the guard would make this 'synced' with an update call.
    expect(second.status).toBe('skipped');
    expect(second.reason).toBe('already_current');
    expect(client.countOf('create', 'Invoice')).toBe(1);
    expect(client.countOf('update', 'Invoice')).toBe(0);

    const links = await testDb.db.select().from(syncLinks).where(eq(syncLinks.localId, invoice.id));
    expect(links).toHaveLength(1);
  });

  it('outbound redundant-write guard does not skip a genuine new local edit', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    const client = createFakeQboWriteClient();

    await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });

    // No edit yet — a re-push is skipped.
    const unchanged = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });
    expect(unchanged.status).toBe('skipped');
    expect(client.countOf('update', 'Invoice')).toBe(0);

    // `transactions.version` advances past the link's recorded `localVersion` -> push resumes.
    const edited = await updateInvoice(
      testDb.db,
      { orgId: seed.orgId, userId: seed.userId },
      invoice.id,
      { memo: 'a real edit' },
    );
    expect(edited.version).toBeGreaterThan(invoice.version);

    const resumed = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });
    expect(resumed.status).toBe('synced');
    expect(client.countOf('update', 'Invoice')).toBe(1);

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.localVersion).toBe(edited.version);
  });

  it('edit -> UPDATE with the stored SyncToken, and the link version advances', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    const client = createFakeQboWriteClient();

    await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });
    const linkAfterCreate = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);

    const edited = await updateInvoice(
      testDb.db,
      { orgId: seed.orgId, userId: seed.userId },
      invoice.id,
      {
        memo: 'updated memo',
      },
    );
    expect(edited.version).toBeGreaterThan(invoice.version);

    const result = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });

    expect(result.status).toBe('synced');
    const updateCall = client.calls.find(
      (c) => c.method === 'update' && c.entityType === 'Invoice',
    );
    expect(updateCall?.body?.SyncToken).toBe(linkAfterCreate?.qboSyncToken);
    expect(updateCall?.body?.sparse).toBe(true);

    const linkAfterEdit = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(linkAfterEdit?.localVersion).toBe(edited.version);
    expect(linkAfterEdit?.qboSyncToken).not.toBe(linkAfterCreate?.qboSyncToken);
  });

  it('void -> QBO void when previously synced; never-synced void is a no-op skip', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);

    // Synced-then-voided invoice: fake sees a void call, link stays synced.
    const synced = await seedInvoice(testDb.db, seed);
    const client = createFakeQboWriteClient();
    await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: synced.id,
      userId: seed.userId,
    });
    await voidInvoice(testDb.db, { orgId: seed.orgId, userId: seed.userId }, synced.id);

    const voidResult = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: synced.id,
      userId: seed.userId,
    });
    expect(voidResult.status).toBe('synced');
    expect(client.countOf('void', 'Invoice')).toBe(1);
    const linkAfterVoid = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', synced.id);
    expect(linkAfterVoid?.state).toBe('synced');

    // Never-synced invoice, voided locally: no QBO call, no error, no link created.
    const neverSynced = await seedInvoice(testDb.db, seed);
    await voidInvoice(testDb.db, { orgId: seed.orgId, userId: seed.userId }, neverSynced.id);
    const skipResult = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: neverSynced.id,
      userId: seed.userId,
    });
    expect(skipResult.status).toBe('skipped');
    expect(client.countOf('void', 'Invoice')).toBe(1); // unchanged
    const linkForNeverSynced = await findLinkByLocal(
      testDb.db,
      seed.orgId,
      'transaction',
      neverSynced.id,
    );
    expect(linkForNeverSynced).toBeNull();
  });

  it('ref gating: a pending ref link is (re)pushed (as an update, since it already has a qboId) before the doc', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    const client = createFakeQboWriteClient();

    // Seed a *pending* contact link with a pre-existing qboId + SyncToken (e.g. from a prior
    // partial attempt) — a pending/failed link must NOT satisfy the synced-gate.
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'contact',
      localId: seed.contact.id,
      qboType: 'Customer',
      qboId: 'preexisting-customer-id',
      state: 'pending',
      qboSyncToken: '0',
    });

    const result = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });

    expect(result.status).toBe('synced');
    // Not a create (the ref already had a qboId) but an update, and it happens before the doc.
    expect(client.countOf('create', 'Customer')).toBe(0);
    expect(client.countOf('update', 'Customer')).toBe(1);
    const contactLink = await findLinkByLocal(testDb.db, seed.orgId, 'contact', seed.contact.id);
    expect(contactLink?.state).toBe('synced');
  });

  it('failure on an update marks the link failed + audits, and the local invoice is untouched', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);

    const client = createFakeQboWriteClient();
    await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });
    await updateInvoice(testDb.db, { orgId: seed.orgId, userId: seed.userId }, invoice.id, {
      memo: 'trigger a re-push',
    });

    const failingClient = createFakeQboWriteClient({
      failOn: (call) =>
        call.method === 'update' && call.entityType === 'Invoice'
          ? new Error('simulated QBO outage')
          : undefined,
    });

    const result = await syncInvoiceOutbound(testDb.db, deps(failingClient), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });

    expect(result.status).toBe('failed');
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('failed');

    const audits = await testDb.db
      .select()
      .from(syncAuditLogs)
      .where(and(eq(syncAuditLogs.orgId, seed.orgId), eq(syncAuditLogs.localId, invoice.id)));
    expect(audits.some((a) => a.outcome === 'failure')).toBe(true);

    // The local invoice was never touched by the outbound failure.
    const contactStillThere = await getContact(testDb.db, seed.orgId, seed.contact.id);
    expect(contactStillThere).not.toBeNull();
  });

  it('20011 headline: a first-ever push failure (no pre-existing link) now seeds a retryable failed link', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);

    // No sync_links row exists at all yet for this invoice — this is the previously-invisible
    // first-ever-failure gap (20006 review / §0a.1): before 20011, `markFailed` was UPDATE-only
    // and nothing seeded a row here, so a retry sweep would never find this invoice.
    expect(await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id)).toBeNull();

    const failingClient = createFakeQboWriteClient({
      failOn: (call) => (call.method === 'create' ? new Error('simulated timeout') : undefined),
    });

    const result = await syncInvoiceOutbound(testDb.db, deps(failingClient), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });

    expect(result.status).toBe('failed');
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link).not.toBeNull();
    expect(link?.state).toBe('failed');
    expect(link?.qboId).toBeNull();
    expect(link?.retryCount).toBe(1);
    expect(link?.nextRetryAt).not.toBeNull();
    expect(link?.lastError).toBeTruthy();
  });

  it('20011 anti-tautology control: a SUCCESSFUL push leaves state=synced with retry fields cleared', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    const client = createFakeQboWriteClient();

    const result = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });

    expect(result.status).toBe('synced');
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('synced');
    expect(link?.retryCount).toBe(0);
    expect(link?.nextRetryAt).toBeNull();
    expect(link?.lastError).toBeNull();
  });

  it('propagates ConflictingLinkError from a ref push as a failed outbound + audit, not a crash', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);

    // Seed the contact's link pointing at one qboId...
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'contact',
      localId: seed.contact.id,
      qboType: 'Customer',
      qboId: 'original-customer-id',
      state: 'pending',
    });

    // ...then rig a client whose update call returns a *different* Id, which upsertLink must
    // refuse to silently relink (throws ConflictingLinkError instead).
    const client: FakeQboWriteClient = {
      ...createFakeQboWriteClient(),
      calls: [],
      countOf: () => 0,
      async getEntity() {
        return { Customer: { Id: 'original-customer-id', SyncToken: '0' } };
      },
      async createEntity() {
        throw new Error('unexpected create call');
      },
      async updateEntity({ entityType }) {
        return { [entityType]: { Id: 'a-different-customer-id', SyncToken: '1' } };
      },
      async voidEntity() {
        throw new Error('unexpected void call');
      },
    };

    const result = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });

    expect(result.status).toBe('failed');
    const contactLink = await findLinkByLocal(testDb.db, seed.orgId, 'contact', seed.contact.id);
    expect(contactLink?.state).toBe('failed');
    const audits = await testDb.db
      .select()
      .from(syncAuditLogs)
      .where(and(eq(syncAuditLogs.orgId, seed.orgId), eq(syncAuditLogs.localId, seed.contact.id)));
    expect(audits.some((a) => a.outcome === 'failure')).toBe(true);
  });
});

describe('syncPaymentOutbound', () => {
  it('ensures the applied invoice is synced first, then pushes a Payment with LinkedTxn', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    const client = createFakeQboWriteClient();

    const { payment } = await recordPayment(
      testDb.db,
      { orgId: seed.orgId, userId: seed.userId },
      invoice.id,
      { amount: 100, txnDate: '2026-01-05' },
    );

    const result = await syncPaymentOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: payment.id,
      userId: seed.userId,
    });

    expect(result.status).toBe('synced');
    expect(client.countOf('create', 'Invoice')).toBe(1); // invoice synced as a side effect
    expect(client.countOf('create', 'Payment')).toBe(1);

    const paymentCall = client.calls.find(
      (c) => c.method === 'create' && c.entityType === 'Payment',
    );
    const invoiceLink = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(paymentCall?.body?.CustomerRef).toEqual({ value: expect.any(String) });
    expect(paymentCall?.body?.Line).toEqual([
      {
        Amount: 100,
        LinkedTxn: [{ TxnId: invoiceLink?.qboId, TxnType: 'Invoice' }],
      },
    ]);

    const paymentLink = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', payment.id);
    expect(paymentLink?.state).toBe('synced');
    expect(paymentLink?.qboType).toBe('Payment');
  });

  it('void -> QBO void for a previously-synced payment', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    const client = createFakeQboWriteClient();

    const { payment } = await recordPayment(
      testDb.db,
      { orgId: seed.orgId, userId: seed.userId },
      invoice.id,
      { amount: 100, txnDate: '2026-01-05' },
    );
    await syncPaymentOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: payment.id,
      userId: seed.userId,
    });
    await voidPayment(testDb.db, { orgId: seed.orgId, userId: seed.userId }, payment.id);

    const result = await syncPaymentOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: payment.id,
      userId: seed.userId,
    });

    expect(result.status).toBe('synced');
    expect(client.countOf('void', 'Payment')).toBe(1);
  });
});

describe('resolveOutboundDeps', () => {
  it('returns null (no-op) when no QBO client is configured', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);

    const result = await resolveOutboundDeps({
      db: testDb.db,
      oauthClient: null,
      apiClient: null,
      orgId,
    });
    expect(result).toBeNull();
  });

  it('returns null (no-op) when the client is configured but the org has no QBO connection', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    const client = createFakeQboWriteClient();
    const oauthClient = {
      authorizeUrl: () => 'https://example.test',
      exchangeCode: async () => {
        throw new Error('unused');
      },
      refresh: async () => {
        throw new Error('unused');
      },
      revoke: async () => {},
    };

    const result = await resolveOutboundDeps({
      db: testDb.db,
      oauthClient,
      apiClient: client,
      orgId,
    });
    expect(result).toBeNull();
  });
});

describe('outbound stop-writing-while-conflict (20010)', () => {
  it('syncInvoiceOutbound on a conflict link is blocked — zero calls to the fake QBO client', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'conflict',
      localVersion: invoice.version,
      qboSyncToken: '3',
    });
    const client = createFakeQboWriteClient();

    const result = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'conflict_blocked' });
    expect(client.calls).toHaveLength(0);

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('conflict');

    const audits = await testDb.db
      .select()
      .from(syncAuditLogs)
      .where(and(eq(syncAuditLogs.orgId, seed.orgId), eq(syncAuditLogs.localId, invoice.id)));
    expect(
      audits.some(
        (a) =>
          a.outcome === 'skipped' &&
          (a.detail as Record<string, unknown> | null)?.reason === 'conflict_blocked',
      ),
    ).toBe(true);
  });

  it('syncPaymentOutbound on a conflict link is blocked — zero calls to the fake QBO client', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    const { payment } = await recordPayment(
      testDb.db,
      { orgId: seed.orgId, userId: seed.userId },
      invoice.id,
      { amount: 100, txnDate: '2026-01-05' },
    );
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: payment.id,
      qboType: 'Payment',
      qboId: 'qbo-pay-1',
      state: 'conflict',
      localVersion: payment.version,
      qboSyncToken: '1',
    });
    const client = createFakeQboWriteClient();

    const result = await syncPaymentOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: payment.id,
      userId: seed.userId,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'conflict_blocked' });
    expect(client.calls).toHaveLength(0);
  });

  it('force=true bypasses the conflict_blocked guard AND the already_current guard — always pushes', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'conflict',
      localVersion: invoice.version, // same as current txn.version -> would be "already_current" too
      qboSyncToken: '3',
    });
    const client = createFakeQboWriteClient();

    const result = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
      force: true,
    });

    expect(result.status).toBe('synced');
    expect(client.countOf('update', 'Invoice') + client.countOf('create', 'Invoice')).toBe(1);

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('synced');
    expect(link?.conflictDetectedAt).toBeNull();
  });

  it('force=true push failure leaves the link in conflict (not failed) — no half-resolved state', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'conflict',
      localVersion: invoice.version,
      qboSyncToken: '3',
    });
    const client = createFakeQboWriteClient({
      failOn: (call) => (call.method === 'update' ? new Error('network blip') : undefined),
    });

    const result = await syncInvoiceOutbound(testDb.db, deps(client), {
      orgId: seed.orgId,
      txnId: invoice.id,
      userId: seed.userId,
      force: true,
    });

    expect(result.status).toBe('failed');

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    // Stayed `conflict`, not flipped to `failed` — a force-push failure during resolution must
    // not drop the link out of `GET /api/conflicts` into the (unrelated) 20011 retry loop.
    expect(link?.state).toBe('conflict');
  });
});
