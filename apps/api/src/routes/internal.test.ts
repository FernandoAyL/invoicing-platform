// Cloud Scheduler hits this route in place of the in-process setInterval sweep on Cloud Run (see
// routes/internal.ts). `config.internalSweepToken` is a module-level singleton read once from
// `SYNC_SWEEP_TOKEN` at import time (apps/api/src/config.ts), so the "configured" tests below
// reset the module registry and re-import with the env var set, rather than relying on any
// buildApp() injection point (this route intentionally has none — it reads real `config`, the
// same way the Cloud Scheduler-driven production endpoint does).
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../__tests__/helpers/test-db.ts';
import { buildApp } from '../app.ts';
import type { QboOAuthClient } from '../qbo/oauth-client.ts';

describe('POST /internal/retry-sweep — not configured (default test env has no SYNC_SWEEP_TOKEN)', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it('returns 503 sweep_not_configured', async () => {
    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });

    const res = await app.inject({ method: 'POST', url: '/internal/retry-sweep' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'sweep_not_configured' });
    await app.close();
  });
});

describe('POST /internal/retry-sweep — configured', () => {
  const TOKEN = 'test-sweep-token-value';

  beforeEach(() => {
    vi.resetModules();
    process.env.SYNC_SWEEP_TOKEN = TOKEN;
  });

  afterEach(() => {
    delete process.env.SYNC_SWEEP_TOKEN;
  });

  it('returns 401 invalid_sweep_token when the header is missing', async () => {
    const { createTestDb: freshCreateTestDb } = await import('../__tests__/helpers/test-db.ts');
    const { buildApp: freshBuildApp } = await import('../app.ts');
    const fresh = await freshCreateTestDb();

    const app = freshBuildApp({ db: fresh.db, qboOAuthClient: null, qboApiClient: null });
    const res = await app.inject({ method: 'POST', url: '/internal/retry-sweep' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_sweep_token' });
    await app.close();
    await fresh.cleanup();
  });

  it('returns 401 invalid_sweep_token when the header is wrong', async () => {
    const { createTestDb: freshCreateTestDb } = await import('../__tests__/helpers/test-db.ts');
    const { buildApp: freshBuildApp } = await import('../app.ts');
    const fresh = await freshCreateTestDb();

    const app = freshBuildApp({ db: fresh.db, qboOAuthClient: null, qboApiClient: null });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/retry-sweep',
      headers: { 'x-sweep-token': 'wrong-token' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_sweep_token' });
    await app.close();
    await fresh.cleanup();
  });

  it('runs the sweep and returns its summary for a correct token', async () => {
    const schemaMod = await import('../db/schema.ts');
    const { createTestDb: freshCreateTestDb, seedBaseOrg: freshSeedBaseOrg } = await import(
      '../__tests__/helpers/test-db.ts'
    );
    const { buildApp: freshBuildApp } = await import('../app.ts');
    const { createInvoice } = await import('../invoices/service.ts');
    const { upsertConnection } = await import('../qbo/connection-service.ts');
    const { markFailed, findLinkByLocal } = await import('../qbo/sync-link-service.ts');
    const { createFakeQboWriteClient } = await import(
      '../__tests__/helpers/fake-qbo-write-client.ts'
    );

    const fresh = await freshCreateTestDb();
    const { orgId } = await freshSeedBaseOrg(fresh.db);

    const [user] = await fresh.db
      .insert(schemaMod.users)
      .values({ orgId, email: 'owner@example.test', passwordHash: 'hash' })
      .returning();
    if (!user) throw new Error('setup: user insert returned no row');

    await fresh.db.insert(schemaMod.accounts).values([
      { orgId, name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
      { orgId, name: 'Sales Income', type: 'income', subtype: 'sales_income' },
    ]);
    const [contact] = await fresh.db
      .insert(schemaMod.contacts)
      .values({ orgId, displayName: 'Acme Co', isCustomer: true })
      .returning();
    if (!contact) throw new Error('setup: contact insert returned no row');
    const [item] = await fresh.db
      .insert(schemaMod.items)
      .values({ orgId, name: 'Consulting', kind: 'service' })
      .returning();
    if (!item) throw new Error('setup: item insert returned no row');

    const invoice = await createInvoice(
      fresh.db,
      { orgId, userId: user.id },
      {
        contactId: contact.id,
        txnDate: '2026-01-01',
        docNumber: 'INV-1',
        lines: [{ itemId: item.id, quantity: 1, unitPrice: '10.00' }],
      },
    );

    await upsertConnection(fresh.db, orgId, {
      realmId: 'realm-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 8_726_400,
    });

    await markFailed(fresh.db, orgId, 'transaction', invoice.id, 'Invoice', 'simulated outage');
    const failedLink = await findLinkByLocal(fresh.db, orgId, 'transaction', invoice.id);
    if (!failedLink) throw new Error('setup: expected a sync link');

    // The route calls runOutboundRetrySweep with a real `new Date()`, so the seeded link's
    // nextRetryAt (computed by markFailed's backoff) must be forced into the real past to be
    // "due" — unlike qbo/retry-sweep.test.ts, which controls `now` directly.
    await fresh.db
      .update(schemaMod.syncLinks)
      .set({ nextRetryAt: new Date(Date.now() - 60_000) })
      .where(eq(schemaMod.syncLinks.id, failedLink.id));

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

    const app = freshBuildApp({
      db: fresh.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: createFakeQboWriteClient(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/internal/retry-sweep',
      headers: { 'x-sweep-token': TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ retried: 1, succeeded: 1, failed: 0, terminal: 0, cleared: 0 });

    const [link] = await fresh.db
      .select()
      .from(schemaMod.syncLinks)
      .where(eq(schemaMod.syncLinks.id, failedLink.id));
    expect(link?.state).toBe('synced');

    await app.close();
    await fresh.cleanup();
  });
});
