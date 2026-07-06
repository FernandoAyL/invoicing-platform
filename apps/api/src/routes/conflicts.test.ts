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
import { applyInboundEntity } from '../qbo/inbound-sync.ts';
import type { QboOAuthClient, QboTokenResult } from '../qbo/oauth-client.ts';
import { findLinkByLocal, markConflict } from '../qbo/sync-link-service.ts';

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

async function seedOrgAndAdmin(orgName = 'Test Org') {
  if (!testDb) testDb = await createTestDb();
  const { orgId } = await seedBaseOrg(testDb.db, { name: orgName });
  const password = 'correct horse battery staple';
  const [admin] = await testDb.db
    .insert(users)
    .values({
      orgId,
      email: `admin-${orgId}@example.test`,
      passwordHash: await hashPassword(password),
      role: 'admin',
    })
    .returning();
  if (!admin) throw new Error('setup: user insert returned no row');

  await testDb.db.insert(accounts).values([
    { orgId, name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
    { orgId, name: 'Sales Income', type: 'income', subtype: 'sales_income' },
    { orgId, name: 'Undeposited Funds', type: 'asset', subtype: 'undeposited_funds' },
  ]);

  return { orgId, email: admin.email, password };
}

function sidCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === 'sid')?.value;
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
    cookies: { sid },
    payload: { displayName, email: `${displayName.toLowerCase().replace(/\s/g, '')}@example.test` },
  });
  return (res.json() as { id: string }).id;
}

/** Creates + outbound-syncs an invoice (so it has a real linked `qboId`), then edits it locally
 * (bumps `transactions.version`) and force-flips its link to `conflict` — a shortcut for route
 * tests, which are about the API contract (GET/POST shape, status codes, audits), not re-proving
 * the detection logic itself (covered exhaustively in `qbo/inbound-sync.test.ts`). */
async function seedConflictedInvoice(
  app: ReturnType<typeof buildApp>,
  sid: string,
  orgId: string,
): Promise<{ invoiceId: string; linkId: string }> {
  const contactId = await createCustomer(app, sid);
  const createRes = await app.inject({
    method: 'POST',
    url: '/api/invoices',
    cookies: { sid },
    payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
  });
  const invoiceId = createRes.json().id as string;

  await app.inject({
    method: 'PATCH',
    url: `/api/invoices/${invoiceId}`,
    cookies: { sid },
    payload: { memo: 'local edit while conflicted' },
  });

  if (!testDb) throw new Error('unreachable');
  await markConflict(testDb.db, orgId, 'transaction', invoiceId);
  const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
  if (!link) throw new Error('setup: expected a sync link after outbound create');

  return { invoiceId, linkId: link.id };
}

/**
 * Builds a REAL conflict — and a real `qbo.inbound.conflict`/`conflict_held` audit trail via
 * `applyInboundEntity` directly — rather than the `markConflict` shortcut above. This is the
 * regression-test path required after QA caught `recoverConflictOperation` picking the wrong
 * operation when a link is held across more than one inbound event while conflicted (a later
 * `Update` row must never override an earlier `Void`/`Delete` row's terminal state).
 *
 * `events` is applied in order via `applyInboundEntity` directly (bypassing the webhook route,
 * exactly like `inbound-sync.test.ts` does) — the first event raises the conflict, any further
 * events exercise `handleAlreadyConflictHold`.
 */
async function seedRealConflictedInvoice(
  app: ReturnType<typeof buildApp>,
  sid: string,
  orgId: string,
  events: Array<{ operation: 'Update' | 'Void' | 'Delete'; syncToken: string }>,
): Promise<{ invoiceId: string; linkId: string; qboId: string }> {
  if (!testDb) throw new Error('unreachable');
  const contactId = await createCustomer(app, sid);
  const createRes = await app.inject({
    method: 'POST',
    url: '/api/invoices',
    cookies: { sid },
    payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
  });
  const invoiceId = createRes.json().id as string;

  const linkBefore = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
  if (!linkBefore?.qboId) throw new Error('setup: expected an outbound-synced link with a qboId');
  const qboId = linkBefore.qboId;

  // Dirty the local row directly — bypassing the API (which would push outbound and re-sync the
  // link, erasing the "local changed since last sync" condition the conflict check needs).
  const [txn] = await testDb.db.select().from(transactions).where(eq(transactions.id, invoiceId));
  if (!txn) throw new Error('setup: transaction not found');
  await testDb.db
    .update(transactions)
    .set({ version: txn.version + 1, memo: 'local edit while conflicted' })
    .where(eq(transactions.id, invoiceId));

  for (const event of events) {
    await testDb.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId,
        realmId: 'realm-1',
        entityType: 'Invoice',
        entity: { name: 'Invoice', id: qboId, operation: event.operation },
        refetched: { Invoice: { Id: qboId, SyncToken: event.syncToken } },
      }),
    );
  }

  const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
  if (!link) throw new Error('setup: expected a sync link');

  return { invoiceId, linkId: link.id, qboId };
}

describe('GET /api/conflicts', () => {
  it('returns an empty list when there are no conflicts', async () => {
    const { password, email } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
    const sid = await login(app, email, password);

    const res = await app.inject({ method: 'GET', url: '/api/conflicts', cookies: { sid } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);

    await app.close();
  });

  it('lists a conflicted link joined to its local transaction for display', async () => {
    const { orgId, password, email } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, email, password);

    const { invoiceId, linkId } = await seedConflictedInvoice(app, sid, orgId);

    const res = await app.inject({ method: 'GET', url: '/api/conflicts', cookies: { sid } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      linkId,
      qboType: 'Invoice',
      transaction: expect.objectContaining({ id: invoiceId }),
    });
    expect(body[0]?.conflictDetectedAt).toBeTruthy();

    await app.close();
  });

  it("does not leak another org's conflicts", async () => {
    const orgA = await seedOrgAndAdmin('Org A');
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgA.orgId, { ...TOKENS, realmId: 'realm-a' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sidA = await login(app, orgA.email, orgA.password);
    await seedConflictedInvoice(app, sidA, orgA.orgId);

    const orgB = await seedOrgAndAdmin('Org B');
    const sidB = await login(app, orgB.email, orgB.password);

    const res = await app.inject({ method: 'GET', url: '/api/conflicts', cookies: { sid: sidB } });
    expect(res.json()).toEqual([]);

    await app.close();
  });
});

describe('POST /api/conflicts/:linkId/resolve', () => {
  it('winner=local: force-pushes local -> QBO, link becomes synced, conflictDetectedAt cleared, audited', async () => {
    const { orgId, password, email } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, email, password);

    const { invoiceId, linkId } = await seedConflictedInvoice(app, sid, orgId);
    const createCalls = client.countOf('create', 'Invoice');
    expect(createCalls).toBe(1);
    // seedConflictedInvoice's own PATCH already pushed one update before flipping to conflict.
    const updatesBeforeResolve = client.countOf('update', 'Invoice');
    expect(updatesBeforeResolve).toBe(1);

    const res = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${linkId}/resolve`,
      cookies: { sid },
      payload: { winner: 'local' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ linkId, state: 'synced', winner: 'local' });
    // The force-push must have issued one more actual write on top of the pre-conflict update.
    expect(client.countOf('update', 'Invoice')).toBe(updatesBeforeResolve + 1);

    const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
    expect(link?.state).toBe('synced');
    expect(link?.conflictDetectedAt).toBeNull();

    const audits = await testDb.db.select().from(syncAuditLogs);
    expect(
      audits.some(
        (a) =>
          a.action === 'conflict.resolved' &&
          (a.detail as Record<string, unknown> | null)?.winner === 'local',
      ),
    ).toBe(true);

    // GET /api/conflicts no longer lists it.
    const listRes = await app.inject({ method: 'GET', url: '/api/conflicts', cookies: { sid } });
    expect(listRes.json()).toEqual([]);

    await app.close();
  });

  it('winner=qbo: refetches + applies the QBO version locally, link becomes synced, audited', async () => {
    const { orgId, password, email } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, email, password);

    const { invoiceId, linkId } = await seedConflictedInvoice(app, sid, orgId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${linkId}/resolve`,
      cookies: { sid },
      payload: { winner: 'qbo' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ linkId, state: 'synced', winner: 'qbo' });
    expect(client.countOf('get', 'Invoice')).toBe(1);

    const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
    expect(link?.state).toBe('synced');
    expect(link?.conflictDetectedAt).toBeNull();

    const audits = await testDb.db.select().from(syncAuditLogs);
    expect(
      audits.some(
        (a) =>
          a.action === 'conflict.resolved' &&
          (a.detail as Record<string, unknown> | null)?.winner === 'qbo',
      ),
    ).toBe(true);

    await app.close();
  });

  it("winner=qbo REGRESSION: Void raised the conflict, a later held Update must not override QBO's true terminal state", async () => {
    const { orgId, password, email } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, email, password);

    const { invoiceId, linkId } = await seedRealConflictedInvoice(app, sid, orgId, [
      { operation: 'Void', syncToken: '1' },
      { operation: 'Update', syncToken: '2' },
    ]);

    // Sanity: a REAL audit trail was written (not the markConflict shortcut) — this is what makes
    // this a genuine regression test for the operation-recovery bug, not just the route contract.
    const auditsBefore = await testDb.db
      .select()
      .from(syncAuditLogs)
      .where(eq(syncAuditLogs.orgId, orgId));
    expect(
      auditsBefore.some(
        (a) =>
          a.action === 'qbo.inbound.conflict' &&
          (a.detail as Record<string, unknown> | null)?.operation === 'Void',
      ),
    ).toBe(true);
    expect(
      auditsBefore.some(
        (a) =>
          a.action === 'qbo.inbound.conflict_held' &&
          (a.detail as Record<string, unknown> | null)?.operation === 'Update',
      ),
    ).toBe(true);
    const linkBefore = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
    expect(linkBefore?.state).toBe('conflict');

    const res = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${linkId}/resolve`,
      cookies: { sid },
      payload: { winner: 'qbo' },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await testDb.db.select().from(transactions).where(eq(transactions.id, invoiceId));
    // The bug: picking the MOST RECENT audit row ('Update') would only patch metadata and leave
    // status 'open', even though QBO's true state (established earlier, and terminal) is void.
    expect(row?.status).toBe('void');

    const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
    expect(link?.state).toBe('synced');
    expect(link?.conflictDetectedAt).toBeNull();

    await app.close();
  });

  it('winner=qbo REGRESSION: Delete raised the conflict, a later held Update must not override — local ends up soft-deleted', async () => {
    const { orgId, password, email } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, email, password);

    const { invoiceId, linkId } = await seedRealConflictedInvoice(app, sid, orgId, [
      { operation: 'Delete', syncToken: '1' },
      { operation: 'Update', syncToken: '2' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${linkId}/resolve`,
      cookies: { sid },
      payload: { winner: 'qbo' },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await testDb.db.select().from(transactions).where(eq(transactions.id, invoiceId));
    expect(row?.deletedAt).not.toBeNull();

    const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
    expect(link?.state).toBe('synced');
    expect(link?.conflictDetectedAt).toBeNull();

    await app.close();
  });

  it('winner=qbo REGRESSION (no-op control): a plain Update-only conflict with a real audit trail still patches metadata correctly', async () => {
    const { orgId, password, email } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, email, password);

    const { invoiceId, linkId } = await seedRealConflictedInvoice(app, sid, orgId, [
      { operation: 'Update', syncToken: '1' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${linkId}/resolve`,
      cookies: { sid },
      payload: { winner: 'qbo' },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await testDb.db.select().from(transactions).where(eq(transactions.id, invoiceId));
    // No Void/Delete row exists — the (single) Update is correctly replayed, not overridden.
    expect(row?.status).toBe('open');
    expect(row?.deletedAt).toBeNull();

    const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
    expect(link?.state).toBe('synced');

    await app.close();
  });

  it('resolving a non-conflict link -> 409', async () => {
    const { orgId, password, email } = await seedOrgAndAdmin();
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
      cookies: { sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    });
    const invoiceId = createRes.json().id as string;
    const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
    if (!link) throw new Error('setup: expected a link');
    expect(link.state).toBe('synced');

    const res = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${link.id}/resolve`,
      cookies: { sid },
      payload: { winner: 'local' },
    });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it('unknown linkId -> 404', async () => {
    const { password, email } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
    const sid = await login(app, email, password);

    const res = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${crypto.randomUUID()}/resolve`,
      cookies: { sid },
      payload: { winner: 'local' },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("cross-org linkId -> 404 (never leaks/resolves another org's conflict)", async () => {
    const orgA = await seedOrgAndAdmin('Org A');
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgA.orgId, { ...TOKENS, realmId: 'realm-a' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sidA = await login(app, orgA.email, orgA.password);
    const { linkId } = await seedConflictedInvoice(app, sidA, orgA.orgId);

    const orgB = await seedOrgAndAdmin('Org B');
    const sidB = await login(app, orgB.email, orgB.password);

    const res = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${linkId}/resolve`,
      cookies: { sid: sidB },
      payload: { winner: 'local' },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('bad winner value -> 400', async () => {
    const { orgId, password, email } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });
    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, email, password);

    const { linkId } = await seedConflictedInvoice(app, sid, orgId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${linkId}/resolve`,
      cookies: { sid },
      payload: { winner: 'nonsense' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('winner=local force-push failure leaves the link in conflict (not half-resolved) and audits resolve_failed', async () => {
    const { orgId, password, email } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });
    const client: FakeQboWriteClient = createFakeQboWriteClient({
      failOn: (call) => (call.method === 'update' ? new Error('simulated outage') : undefined),
    });
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, email, password);

    const { invoiceId, linkId } = await seedConflictedInvoice(app, sid, orgId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${linkId}/resolve`,
      cookies: { sid },
      payload: { winner: 'local' },
    });
    expect(res.statusCode).toBe(502);

    const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
    expect(link?.state).toBe('conflict');

    const audits = await testDb.db.select().from(syncAuditLogs);
    expect(audits.some((a) => a.action === 'conflict.resolve_failed')).toBe(true);

    // Still listed for the user to retry.
    const listRes = await app.inject({ method: 'GET', url: '/api/conflicts', cookies: { sid } });
    expect((listRes.json() as unknown[]).length).toBe(1);

    await app.close();
  });
});
