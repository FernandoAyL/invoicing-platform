import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFakeQboWriteClient,
  type FakeQboWriteClient,
} from '../__tests__/helpers/fake-qbo-write-client.ts';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import { buildApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import { accounts, syncAuditLogs, transactions, users } from '../db/schema.ts';
import { upsertConnection } from '../qbo/connection-service.ts';
import type { QboOAuthClient, QboTokenResult } from '../qbo/oauth-client.ts';
import { findLinkByLocal, markFailed } from '../qbo/sync-link-service.ts';

const TOKENS: QboTokenResult = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresIn: 3600,
  refreshTokenExpiresIn: 8726400,
};

function fakeOAuthClient(): QboOAuthClient {
  return {
    authorizeUrl: () => 'https://example.test/authorize',
    exchangeCode: async () => TOKENS,
    refresh: async () => TOKENS,
    revoke: async () => {},
  };
}

let testDb: TestDb | undefined;

afterEach(async () => {
  await testDb?.cleanup();
  testDb = undefined;
});

async function seedOrgAndUser(orgName = 'Test Org') {
  if (!testDb) testDb = await createTestDb();
  const { orgId } = await seedBaseOrg(testDb.db, { name: orgName });
  const password = 'correct horse battery staple';
  const [user] = await testDb.db
    .insert(users)
    .values({
      orgId,
      email: `owner-${orgId}@example.test`,
      passwordHash: await hashPassword(password),
    })
    .returning();
  if (!user) throw new Error('setup: user insert returned no row');

  await testDb.db.insert(accounts).values([
    { orgId, name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
    { orgId, name: 'Sales Income', type: 'income', subtype: 'sales_income' },
  ]);

  return { orgId, email: user.email, password };
}

function sidCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === '__session')?.value;
}

async function login(
  app: ReturnType<typeof buildApp>,
  email: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  const sid = sidCookie(res);
  if (!sid) throw new Error('login failed in test setup');
  return sid;
}

async function createCustomer(
  app: ReturnType<typeof buildApp>,
  sid: string,
  displayName = 'Acme Co',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/contacts',
    cookies: { __session: sid },
    payload: { displayName, email: `${displayName.toLowerCase().replace(/\s/g, '')}@example.test` },
  });
  return (res.json() as { id: string }).id;
}

/** Creates + outbound-syncs an invoice via the real API (so it has a real linked `qboId`), then
 * force-fails its link directly — a shortcut for route tests, which are about the API contract
 * (GET/POST shape, status codes, audits), not re-proving the retry engine itself (covered
 * exhaustively in `qbo/retry-sweep.test.ts`). */
async function seedFailedInvoice(
  app: ReturnType<typeof buildApp>,
  sid: string,
  orgId: string,
): Promise<{ invoiceId: string; linkId: string }> {
  const contactId = await createCustomer(app, sid);
  const createRes = await app.inject({
    method: 'POST',
    url: '/api/invoices',
    cookies: { __session: sid },
    payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
  });
  const invoiceId = createRes.json().id as string;

  if (!testDb) throw new Error('unreachable');
  // Bump `transactions.version` directly (bypassing the API, same shortcut
  // `conflicts.test.ts`'s `seedRealConflictedInvoice` uses) so the link's recorded `localVersion`
  // lags behind the current version — modeling the realistic failure shape (an edit's outbound
  // push failed, so the edit was never recorded as synced) rather than an unrealistic
  // "already-current, unedited, yet failed" state, which the outbound redundant-write guard
  // (`isOutboundRedundant`, 20008 §0a.4) would otherwise skip on retry (correctly — that guard
  // exists precisely so an unedited push is a no-op, but it means a no-op-shaped retry test would
  // never actually re-issue and observe the retry take effect).
  const [txn] = await testDb.db.select().from(transactions).where(eq(transactions.id, invoiceId));
  if (!txn) throw new Error('setup: transaction not found');
  await testDb.db
    .update(transactions)
    .set({ version: txn.version + 1, memo: 'edit that failed to push' })
    .where(eq(transactions.id, invoiceId));

  await markFailed(testDb.db, orgId, 'transaction', invoiceId, 'Invoice', 'simulated outage');
  const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
  if (!link) throw new Error('setup: expected a sync link');

  return { invoiceId, linkId: link.id };
}

describe('GET /api/sync/failures', () => {
  it('returns an empty list when there are no failures', async () => {
    const { password, email } = await seedOrgAndUser();
    if (!testDb) throw new Error('unreachable');
    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
    const sid = await login(app, email, password);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sync/failures',
      cookies: { __session: sid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);

    await app.close();
  });

  it('lists a failed link joined to its local transaction, with retry bookkeeping', async () => {
    const { orgId, password, email } = await seedOrgAndUser();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, email, password);

    const { invoiceId, linkId } = await seedFailedInvoice(app, sid, orgId);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sync/failures',
      cookies: { __session: sid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      linkId,
      qboType: 'Invoice',
      retryCount: 1,
      lastError: 'simulated outage',
      transaction: expect.objectContaining({ id: invoiceId }),
    });
    expect(body[0]?.nextRetryAt).toBeTruthy();

    await app.close();
  });

  it("does not leak another org's failures", async () => {
    const orgA = await seedOrgAndUser('Org A');
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgA.orgId, { ...TOKENS, realmId: 'realm-a' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sidA = await login(app, orgA.email, orgA.password);
    await seedFailedInvoice(app, sidA, orgA.orgId);

    const orgB = await seedOrgAndUser('Org B');
    const sidB = await login(app, orgB.email, orgB.password);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sync/failures',
      cookies: { __session: sidB },
    });
    expect(res.json()).toEqual([]);

    await app.close();
  });
});

describe('POST /api/sync/failures/:linkId/retry', () => {
  it('forces an immediate retry (ignoring backoff) and audits sync.manual_retry on success', async () => {
    const { orgId, password, email } = await seedOrgAndUser();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, email, password);

    const { linkId } = await seedFailedInvoice(app, sid, orgId);
    const updatesBefore = client.countOf('update', 'Invoice');

    const res = await app.inject({
      method: 'POST',
      url: `/api/sync/failures/${linkId}/retry`,
      cookies: { __session: sid },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ linkId, outcome: 'succeeded', state: 'synced' });
    // The link already had a qboId (it was synced before being force-failed) -> the retry re-issues
    // as an UPDATE, not a duplicate create.
    expect(client.countOf('update', 'Invoice')).toBe(updatesBefore + 1);

    const audits = await testDb.db
      .select()
      .from(syncAuditLogs)
      .where(eq(syncAuditLogs.action, 'sync.manual_retry'));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe('success');

    await app.close();
  });

  it('409s when the link is not in failed state', async () => {
    const { orgId, password, email } = await seedOrgAndUser();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, email, password);

    const contactId = await createCustomer(app, sid);
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { __session: sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    });
    const invoiceId = createRes.json().id as string;
    const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
    if (!link) throw new Error('setup: expected a synced link');
    expect(link.state).toBe('synced');

    const res = await app.inject({
      method: 'POST',
      url: `/api/sync/failures/${link.id}/retry`,
      cookies: { __session: sid },
    });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it('404s for an unknown or cross-org linkId', async () => {
    const orgA = await seedOrgAndUser('Org A');
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgA.orgId, { ...TOKENS, realmId: 'realm-a' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sidA = await login(app, orgA.email, orgA.password);
    const { linkId } = await seedFailedInvoice(app, sidA, orgA.orgId);

    const orgB = await seedOrgAndUser('Org B');
    const sidB = await login(app, orgB.email, orgB.password);

    const crossOrgRes = await app.inject({
      method: 'POST',
      url: `/api/sync/failures/${linkId}/retry`,
      cookies: { __session: sidB },
    });
    expect(crossOrgRes.statusCode).toBe(404);

    const unknownRes = await app.inject({
      method: 'POST',
      url: `/api/sync/failures/${crypto.randomUUID()}/retry`,
      cookies: { __session: sidA },
    });
    expect(unknownRes.statusCode).toBe(404);

    await app.close();
  });
});
