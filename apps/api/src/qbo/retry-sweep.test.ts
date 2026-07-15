import { afterEach, describe, expect, it } from 'vitest';
import {
  createFakeQboWriteClient,
  type FakeQboWriteClient,
} from '../__tests__/helpers/fake-qbo-write-client.ts';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import { accounts, contacts, items, users } from '../db/schema.ts';
import { createInvoice, deleteInvoice, voidInvoice } from '../invoices/service.ts';
import { upsertConnection } from './connection-service.ts';
import type { QboOAuthClient } from './oauth-client.ts';
import { MAX_RETRY_ATTEMPTS } from './retry.ts';
import {
  buildContactCreateWhere,
  buildDocumentCreateWhere,
  escapeQboString,
  retryOneFailedLink,
  runOutboundRetrySweep,
} from './retry-sweep.ts';
import {
  findFailedLinksDue,
  findLinkByLocal,
  markFailed,
  upsertLink,
} from './sync-link-service.ts';

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

  const [ar, salesIncome] = await db
    .insert(accounts)
    .values([
      { orgId, name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
      { orgId, name: 'Sales Income', type: 'income', subtype: 'sales_income' },
    ])
    .returning();
  if (!ar || !salesIncome) throw new Error('setup: account insert short');

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

  return { orgId, userId: user.id, ar, salesIncome, contact, item };
}

async function seedInvoice(
  db: TestDb['db'],
  seed: Awaited<ReturnType<typeof seedOrg>>,
  overrides: { docNumber?: string; unitPrice?: string; quantity?: number } = {},
) {
  return createInvoice(
    db,
    { orgId: seed.orgId, userId: seed.userId },
    {
      contactId: seed.contact.id,
      txnDate: '2026-01-01',
      docNumber: overrides.docNumber ?? 'INV-1',
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

/** `resolveOutboundDeps` (called by the sweep, per-org) requires a `qbo_connections` row to
 * resolve deps at all — without one it treats the org as "not connected" and skips it (the
 * dedicated "no connection" test below relies on this row being ABSENT). A far-future
 * `accessTokenExpiresAt` keeps `getValidAccessToken` on the "fresh, no refresh needed" path, so
 * tests never need a working `oauthClient.refresh` (the shared `fakeOAuthClient()` throws if
 * called, by design — it should never be hit here). */
async function seedQboConnection(db: TestDb['db'], orgId: string): Promise<void> {
  // Goes through connection-service.ts (not a raw insert) so the row is encrypted at rest like
  // production writes (30020) — getValidAccessToken/getConnection would otherwise fail to decrypt it.
  await upsertConnection(db, orgId, {
    realmId: 'realm-1',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessTokenExpiresIn: 3600,
    refreshTokenExpiresIn: 86_400,
  });
}

function fakeOAuthClient(): QboOAuthClient {
  return {
    authorizeUrl: () => 'https://example.test',
    exchangeCode: async () => {
      throw new Error('unused');
    },
    refresh: async () => {
      throw new Error('unused');
    },
    revoke: async () => {},
  };
}

describe('runOutboundRetrySweep', () => {
  it('retries a due failed link and succeeds, clearing retry bookkeeping', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedQboConnection(testDb.db, seed.orgId);
    const invoice = await seedInvoice(testDb.db, seed);
    await markFailed(testDb.db, seed.orgId, 'transaction', invoice.id, 'Invoice', 'simulated');
    const failedLink = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    if (!failedLink?.nextRetryAt) throw new Error('setup: expected a due nextRetryAt');

    const client = createFakeQboWriteClient();
    const due = new Date(failedLink.nextRetryAt.getTime() + 1);

    const summary = await runOutboundRetrySweep(
      testDb.db,
      { oauthClient: fakeOAuthClient(), apiClient: client },
      due,
    );

    expect(summary).toEqual({ retried: 1, succeeded: 1, failed: 0, terminal: 0, cleared: 0 });
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('synced');
    expect(link?.retryCount).toBe(0);
    expect(link?.nextRetryAt).toBeNull();
    expect(link?.lastError).toBeNull();
    expect(client.countOf('create', 'Invoice')).toBe(1);
  });

  it('does not retry a failed link whose nextRetryAt is still in the future', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedQboConnection(testDb.db, seed.orgId);
    const invoice = await seedInvoice(testDb.db, seed);
    await markFailed(testDb.db, seed.orgId, 'transaction', invoice.id, 'Invoice', 'simulated');

    const client = createFakeQboWriteClient();
    const summary = await runOutboundRetrySweep(
      testDb.db,
      { oauthClient: fakeOAuthClient(), apiClient: client },
      new Date(), // immediately, before the ~30s backoff elapses
    );

    expect(summary).toEqual({ retried: 0, succeeded: 0, failed: 0, terminal: 0, cleared: 0 });
    expect(client.calls).toHaveLength(0);
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('failed');
  });

  it('a repeated failure bumps retryCount/nextRetryAt each tick, then goes terminal at the cap and is excluded from further sweeps', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedQboConnection(testDb.db, seed.orgId);
    const invoice = await seedInvoice(testDb.db, seed);

    // Pre-link every ref (contact/account/item) as already-`synced` so `ensureEntitySynced`
    // short-circuits for them without any client call — isolates this test to the invoice's OWN
    // repeated create-failure loop, rather than also cascading into parallel ref-link failures
    // (which the failing client's blanket `create` failure would otherwise cause, and which would
    // pollute `summary.retried` with unrelated ref retries on a later tick).
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'contact',
      localId: seed.contact.id,
      qboType: 'Customer',
      qboId: 'qbo-customer-1',
      state: 'synced',
    });
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'account',
      localId: seed.salesIncome.id,
      qboType: 'Account',
      qboId: 'qbo-account-1',
      state: 'synced',
    });
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'item',
      localId: seed.item.id,
      qboType: 'Item',
      qboId: 'qbo-item-1',
      state: 'synced',
    });

    const failingClient = createFakeQboWriteClient({
      failOn: (call) => (call.method === 'create' ? new Error('still down') : undefined),
    });

    let now = new Date();
    await markFailed(testDb.db, seed.orgId, 'transaction', invoice.id, 'Invoice', 'seed');

    let lastRetryCount = 1;
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
      const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
      if (!link || link.nextRetryAt === null) break; // reached terminal
      now = new Date(link.nextRetryAt.getTime() + 1);
      const summary = await runOutboundRetrySweep(
        testDb.db,
        { oauthClient: fakeOAuthClient(), apiClient: failingClient },
        now,
      );
      expect(summary.retried).toBe(1);
      const updated = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
      expect(updated?.retryCount).toBeGreaterThan(lastRetryCount - 1);
      lastRetryCount = updated?.retryCount ?? lastRetryCount;
    }

    const terminal = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(terminal?.state).toBe('failed');
    expect(terminal?.retryCount).toBe(MAX_RETRY_ATTEMPTS);
    expect(terminal?.nextRetryAt).toBeNull();

    // A subsequent sweep (even far in the future) does not retry a terminal link.
    const farFuture = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    const summary = await runOutboundRetrySweep(
      testDb.db,
      { oauthClient: fakeOAuthClient(), apiClient: failingClient },
      farFuture,
    );
    expect(summary).toEqual({ retried: 0, succeeded: 0, failed: 0, terminal: 0, cleared: 0 });
  });

  it('partial-success reconcile: a create that landed but whose link-write failed is LINKED on retry, never duplicated', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedQboConnection(testDb.db, seed.orgId);
    const invoice = await seedInvoice(testDb.db, seed, { docNumber: 'INV-RECONCILE' });

    const client = createFakeQboWriteClient();
    // Simulate "the create actually landed at QBO" — done directly against the fake's store,
    // standing in for a prior attempt whose HTTP response (or the local link write that should
    // have followed it) was lost.
    await client.createEntity({
      realmId: 'realm-1',
      accessToken: 'access-1',
      entityType: 'Invoice',
      body: {
        DocNumber: 'INV-RECONCILE',
        TxnDate: '2026-01-01',
        CustomerRef: { value: 'some-customer-id' },
        Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: {} }],
      },
    });
    expect(client.countOf('create', 'Invoice')).toBe(1);

    // ...but locally we only have a `failed` link (qboId null) — the link write never happened.
    await markFailed(
      testDb.db,
      seed.orgId,
      'transaction',
      invoice.id,
      'Invoice',
      'simulated: create landed, link write lost',
    );
    const failedLink = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    if (!failedLink?.nextRetryAt) throw new Error('setup: expected a due nextRetryAt');

    const summary = await runOutboundRetrySweep(
      testDb.db,
      { oauthClient: fakeOAuthClient(), apiClient: client },
      new Date(failedLink.nextRetryAt.getTime() + 1),
    );

    expect(summary).toEqual({ retried: 1, succeeded: 1, failed: 0, terminal: 0, cleared: 0 });
    // The headline assertion: reconciliation found the existing QBO record and LINKED to it — no
    // second create call. A duplicate create here would be a duplicated financial record.
    expect(client.countOf('create', 'Invoice')).toBe(1);

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('synced');
    expect(link?.qboId).toBe('1'); // the fake's first assigned id
  });

  it('partial-success reconcile with an adversarial docNumber: an embedded quote is escaped in the actual where clause sent to QBO', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedQboConnection(testDb.db, seed.orgId);
    const invoice = await seedInvoice(testDb.db, seed, { docNumber: "INV-O'BRIEN" });

    const client = createFakeQboWriteClient();
    await client.createEntity({
      realmId: 'realm-1',
      accessToken: 'access-1',
      entityType: 'Invoice',
      body: {
        DocNumber: "INV-O'BRIEN",
        TxnDate: '2026-01-01',
        CustomerRef: { value: 'some-customer-id' },
        Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: {} }],
      },
    });

    await markFailed(
      testDb.db,
      seed.orgId,
      'transaction',
      invoice.id,
      'Invoice',
      'simulated: create landed, link write lost',
    );
    const failedLink = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    if (!failedLink?.nextRetryAt) throw new Error('setup: expected a due nextRetryAt');

    const summary = await runOutboundRetrySweep(
      testDb.db,
      { oauthClient: fakeOAuthClient(), apiClient: client },
      new Date(failedLink.nextRetryAt.getTime() + 1),
    );

    expect(summary).toEqual({ retried: 1, succeeded: 1, failed: 0, terminal: 0, cleared: 0 });
    const queryCall = client.calls.find((c) => c.method === 'query' && c.entityType === 'Invoice');
    expect(queryCall?.where).toBe("DocNumber = 'INV-O\\'BRIEN'");

    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('synced');
  });

  it('conflict links are never selected by the sweep', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedQboConnection(testDb.db, seed.orgId);
    const invoice = await seedInvoice(testDb.db, seed);
    await upsertLink(testDb.db, {
      orgId: seed.orgId,
      entityType: 'transaction',
      localId: invoice.id,
      qboType: 'Invoice',
      qboId: 'qbo-inv-1',
      state: 'conflict',
    });

    const client = createFakeQboWriteClient();
    const summary = await runOutboundRetrySweep(
      testDb.db,
      { oauthClient: fakeOAuthClient(), apiClient: client },
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    );

    expect(summary).toEqual({ retried: 0, succeeded: 0, failed: 0, terminal: 0, cleared: 0 });
    expect(client.calls).toHaveLength(0);
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('conflict');
  });

  it('an org with no QBO connection is skipped this tick — the link stays failed, untouched', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await markFailed(testDb.db, seed.orgId, 'transaction', invoice.id, 'Invoice', 'simulated');
    const failedLink = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    if (!failedLink?.nextRetryAt) throw new Error('setup: expected a due nextRetryAt');

    const client = createFakeQboWriteClient();
    // No qboConnections row was ever created for this org -> resolveOutboundDeps returns null.
    const summary = await runOutboundRetrySweep(
      testDb.db,
      { oauthClient: fakeOAuthClient(), apiClient: client },
      new Date(failedLink.nextRetryAt.getTime() + 1),
    );

    expect(summary).toEqual({ retried: 0, succeeded: 0, failed: 0, terminal: 0, cleared: 0 });
    expect(client.calls).toHaveLength(0);
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link?.state).toBe('failed');
  });
});

describe('code-review fix: never-synced failed link + terminal local state (no perpetual retry loop)', () => {
  it('sweep: a never-synced failed link is CLEARED (removed) once its txn is soft-deleted', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedQboConnection(testDb.db, seed.orgId);
    const invoice = await seedInvoice(testDb.db, seed);

    // First-ever CREATE failure -> a `failed` link with qboId=null (the headline 20011 gap).
    await markFailed(
      testDb.db,
      seed.orgId,
      'transaction',
      invoice.id,
      'Invoice',
      'simulated timeout',
    );
    const failedLink = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    if (!failedLink?.nextRetryAt) throw new Error('setup: expected a due nextRetryAt');
    expect(failedLink.qboId).toBeNull();

    // The user soft-deletes the invoice before it ever reached QBO.
    await deleteInvoice(testDb.db, { orgId: seed.orgId, userId: seed.userId }, invoice.id);

    const client = createFakeQboWriteClient();
    const due = new Date(failedLink.nextRetryAt.getTime() + 1);
    const summary = await runOutboundRetrySweep(
      testDb.db,
      { oauthClient: fakeOAuthClient(), apiClient: client },
      due,
    );

    expect(summary).toEqual({ retried: 1, succeeded: 0, failed: 0, terminal: 0, cleared: 1 });
    expect(client.calls).toHaveLength(0); // nothing to sync — never reached QBO, no call made.
    expect(await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id)).toBeNull();

    // It does not reappear in the due-links query, and a second sweep finds nothing to do.
    expect(
      await findFailedLinksDue(testDb.db, new Date(due.getTime() + 365 * 24 * 60 * 60 * 1000)),
    ).toEqual([]);
    const secondSummary = await runOutboundRetrySweep(
      testDb.db,
      { oauthClient: fakeOAuthClient(), apiClient: client },
      new Date(due.getTime() + 365 * 24 * 60 * 60 * 1000),
    );
    expect(secondSummary).toEqual({ retried: 0, succeeded: 0, failed: 0, terminal: 0, cleared: 0 });
  });

  it('sweep: a never-synced failed link is CLEARED once its txn is locally voided', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedQboConnection(testDb.db, seed.orgId);
    const invoice = await seedInvoice(testDb.db, seed);

    await markFailed(
      testDb.db,
      seed.orgId,
      'transaction',
      invoice.id,
      'Invoice',
      'simulated timeout',
    );
    const failedLink = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    if (!failedLink?.nextRetryAt) throw new Error('setup: expected a due nextRetryAt');

    await voidInvoice(testDb.db, { orgId: seed.orgId, userId: seed.userId }, invoice.id);

    const client = createFakeQboWriteClient();
    const summary = await runOutboundRetrySweep(
      testDb.db,
      { oauthClient: fakeOAuthClient(), apiClient: client },
      new Date(failedLink.nextRetryAt.getTime() + 1),
    );

    expect(summary).toEqual({ retried: 1, succeeded: 0, failed: 0, terminal: 0, cleared: 1 });
    expect(client.calls).toHaveLength(0);
    expect(await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id)).toBeNull();
  });

  it('control: a never-synced failed link of a still-OPEN txn is retried normally by the sweep, NOT deleted', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    await seedQboConnection(testDb.db, seed.orgId);
    const invoice = await seedInvoice(testDb.db, seed);

    await markFailed(
      testDb.db,
      seed.orgId,
      'transaction',
      invoice.id,
      'Invoice',
      'simulated timeout',
    );
    const failedLink = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    if (!failedLink?.nextRetryAt) throw new Error('setup: expected a due nextRetryAt');
    expect(failedLink.qboId).toBeNull();

    // No delete/void — the invoice is still open (the legitimate first-ever-failure case).
    const client = createFakeQboWriteClient();
    const outcome = await retryOneFailedLink(
      testDb.db,
      { client, realmId: 'realm-1', accessToken: 'access-1' },
      failedLink,
    );

    expect(outcome).toBe('succeeded');
    expect(client.countOf('create', 'Invoice')).toBe(1);
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(link).not.toBeNull();
    expect(link?.state).toBe('synced');
  });
});

describe('retryOneFailedLink (manual retry entry point)', () => {
  it('forces an immediate attempt ignoring nextRetryAt', async () => {
    testDb = await createTestDb();
    const seed = await seedOrg(testDb.db);
    const invoice = await seedInvoice(testDb.db, seed);
    await markFailed(testDb.db, seed.orgId, 'transaction', invoice.id, 'Invoice', 'simulated');
    const link = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    if (!link) throw new Error('setup: expected a failed link');

    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const outcome = await retryOneFailedLink(
      testDb.db,
      { client, realmId: 'realm-1', accessToken: 'access-1' },
      link,
    );

    expect(outcome).toBe('succeeded');
    const updated = await findLinkByLocal(testDb.db, seed.orgId, 'transaction', invoice.id);
    expect(updated?.state).toBe('synced');
  });
});

// 30026: the where-clause builders are pure and exported so adversarial input can be exercised
// directly, without needing to smuggle a bad value through a real DB round-trip (which is
// impossible for `txnDate` specifically — see the file-level analysis in the plan).
describe('escapeQboString', () => {
  it('escapes an embedded single quote', () => {
    expect(escapeQboString("O'Brien")).toBe("O\\'Brien");
  });

  it('escapes an embedded backslash', () => {
    expect(escapeQboString('a\\b')).toBe('a\\\\b');
  });

  it('escapes backslash before quote, so a backslash-then-quote sequence never double-escapes', () => {
    // Input: a \ b ' c  ->  backslash pass: a \\ b ' c  ->  quote pass: a \\ b \' c
    expect(escapeQboString("a\\b'c")).toBe("a\\\\b\\'c");
  });

  it('leaves the empty string unchanged', () => {
    expect(escapeQboString('')).toBe('');
  });
});

const WHERE_SHAPE = /^\w+(\.\w+)? = '(?:[^'\\]|\\.)*'$/;

describe('buildDocumentCreateWhere', () => {
  it('uses DocNumber when present, with quote/backslash escaped', () => {
    const where = buildDocumentCreateWhere({ docNumber: "INV-O'BRIEN\\1", txnDate: '2026-01-01' });
    expect(where).toBe("DocNumber = 'INV-O\\'BRIEN\\\\1'");
    expect(where).toMatch(WHERE_SHAPE);
  });

  it('falls back to TxnDate (now escaped too) when docNumber is null', () => {
    const where = buildDocumentCreateWhere({ docNumber: null, txnDate: '2026-01-01' });
    expect(where).toBe("TxnDate = '2026-01-01'");
    expect(where).toMatch(WHERE_SHAPE);
  });

  it('falls back to TxnDate when docNumber is the empty string (falsy, same as null)', () => {
    const where = buildDocumentCreateWhere({ docNumber: '', txnDate: '2026-01-01' });
    expect(where).toBe("TxnDate = '2026-01-01'");
  });

  it('escapes an adversarial txnDate on the fallback branch (defense-in-depth — a real `date` column can never actually contain this)', () => {
    const where = buildDocumentCreateWhere({ docNumber: null, txnDate: "2026-01-01' OR '1'='1" });
    expect(where).toBe("TxnDate = '2026-01-01\\' OR \\'1\\'=\\'1'");
    expect(where).toMatch(WHERE_SHAPE);
  });
});

describe('buildContactCreateWhere', () => {
  it('uses PrimaryEmailAddr.Address when present, with quote escaped', () => {
    const where = buildContactCreateWhere({
      email: "o'brien@example.test",
      displayName: "O'Brien",
    });
    expect(where).toBe("PrimaryEmailAddr.Address = 'o\\'brien@example.test'");
    expect(where).toMatch(WHERE_SHAPE);
  });

  it('falls back to DisplayName (already escaped pre-fix) when email is null', () => {
    const where = buildContactCreateWhere({ email: null, displayName: "O'Brien" });
    expect(where).toBe("DisplayName = 'O\\'Brien'");
    expect(where).toMatch(WHERE_SHAPE);
  });

  it('falls back to DisplayName when email is the empty string (falsy, same as null)', () => {
    const where = buildContactCreateWhere({ email: '', displayName: 'Acme Co' });
    expect(where).toBe("DisplayName = 'Acme Co'");
  });
});
