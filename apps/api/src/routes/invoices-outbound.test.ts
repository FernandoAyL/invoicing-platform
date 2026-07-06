import { afterEach, describe, expect, it } from 'vitest';
import {
  createFakeQboWriteClient,
  type FakeQboWriteClient,
} from '../__tests__/helpers/fake-qbo-write-client.ts';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import { buildApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import { accounts, users } from '../db/schema.ts';
import { upsertConnection } from '../qbo/connection-service.ts';
import type { QboOAuthClient, QboTokenResult } from '../qbo/oauth-client.ts';

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

async function seedOrgAndAdmin() {
  testDb = await createTestDb();
  const { orgId } = await seedBaseOrg(testDb.db);
  const password = 'correct horse battery staple';
  const [admin] = await testDb.db
    .insert(users)
    .values({
      orgId,
      email: 'admin@example.test',
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

  return { orgId, password };
}

function sidCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === 'sid')?.value;
}

async function login(app: ReturnType<typeof buildApp>, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@example.test', password },
  });
  const sid = sidCookie(res);
  if (!sid) throw new Error('login failed in test setup');
  return sid;
}

async function createCustomer(app: ReturnType<typeof buildApp>, sid: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/contacts',
    cookies: { sid },
    payload: { displayName: 'Acme Co', email: 'acme@example.test' },
  });
  return (res.json() as { id: string }).id;
}

describe('POST /api/invoices — outbound wiring', () => {
  it('is a no-op when no QBO client is configured (existing behavior unaffected)', async () => {
    const { password } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
    const sid = await login(app, password);
    const contactId = await createCustomer(app, sid);

    const res = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().syncState).toBe('pending');

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/invoices/${res.json().id}`,
      cookies: { sid },
    });
    expect(getRes.json().syncState).toBe('pending');

    await app.close();
  });

  it('pushes the invoice outbound when a QBO connection is configured, ending up synced', async () => {
    const { orgId, password } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });

    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, password);
    const contactId = await createCustomer(app, sid);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    });
    expect(createRes.statusCode).toBe(201);
    expect(client.countOf('create', 'Invoice')).toBe(1);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/invoices/${createRes.json().id}`,
      cookies: { sid },
    });
    expect(getRes.json().syncState).toBe('synced');

    await app.close();
  });

  it('never fails the HTTP response when the outbound push itself fails', async () => {
    const { orgId, password } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });

    const client: FakeQboWriteClient = createFakeQboWriteClient({
      failOn: (call) => (call.method === 'create' ? new Error('simulated outage') : undefined),
    });
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, password);
    const contactId = await createCustomer(app, sid);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    });

    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().total).toBe('100.00');

    await app.close();
  });

  it('void: pushes a QBO void once previously synced', async () => {
    const { orgId, password } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });

    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, password);
    const contactId = await createCustomer(app, sid);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    });
    const invoiceId = createRes.json().id as string;

    const voidRes = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/void`,
      cookies: { sid },
    });
    expect(voidRes.statusCode).toBe(200);
    expect(client.countOf('void', 'Invoice')).toBe(1);

    await app.close();
  });

  it('delete: pushes a QBO delete (not a void) once previously synced — the outbound headline distinction (20009)', async () => {
    const { orgId, password } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });

    const client: FakeQboWriteClient = createFakeQboWriteClient();
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, password);
    const contactId = await createCustomer(app, sid);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    });
    const invoiceId = createRes.json().id as string;

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/invoices/${invoiceId}`,
      cookies: { sid },
    });
    expect(deleteRes.statusCode).toBe(200);
    // Anti-tautology: a delete call happened, and NO void call happened — proves the outbound
    // entry point routes on `deletedAt`, not `status`, and never collapses the two.
    expect(client.countOf('delete', 'Invoice')).toBe(1);
    expect(client.countOf('void', 'Invoice')).toBe(0);

    await app.close();
  });

  it('never-synced delete is a no-op — no QBO call, matching the never-synced-void behavior', async () => {
    const { orgId, password } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    await upsertConnection(testDb.db, orgId, { ...TOKENS, realmId: 'realm-1' });

    // A client whose create call fails, so the invoice is created locally but never actually
    // synced to QBO (no SyncLink with a qboId) — mirrors the existing "never-synced void" case.
    const client: FakeQboWriteClient = createFakeQboWriteClient({
      failOn: (call) => (call.method === 'create' ? new Error('simulated outage') : undefined),
    });
    const app = buildApp({
      db: testDb.db,
      qboOAuthClient: fakeOAuthClient(),
      qboApiClient: client,
    });
    const sid = await login(app, password);
    const contactId = await createCustomer(app, sid);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      cookies: { sid },
      payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice: 100 }] },
    });
    const invoiceId = createRes.json().id as string;

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/invoices/${invoiceId}`,
      cookies: { sid },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(client.countOf('delete', 'Invoice')).toBe(0);

    await app.close();
  });
});
