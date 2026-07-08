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
  return res.cookies.find((c) => c.name === '__session')?.value;
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

async function createInvoice(
  app: ReturnType<typeof buildApp>,
  sid: string,
  unitPrice: number,
): Promise<string> {
  const contactRes = await app.inject({
    method: 'POST',
    url: '/api/contacts',
    cookies: { __session: sid },
    payload: { displayName: 'Acme Co', email: 'acme@example.test' },
  });
  const contactId = (contactRes.json() as { id: string }).id;

  const invoiceRes = await app.inject({
    method: 'POST',
    url: '/api/invoices',
    cookies: { __session: sid },
    payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice }] },
  });
  return (invoiceRes.json() as { id: string }).id;
}

describe('POST /api/invoices/:id/payments — outbound wiring', () => {
  it('is a no-op when no QBO client is configured', async () => {
    const { password } = await seedOrgAndAdmin();
    if (!testDb) throw new Error('unreachable');
    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
    const sid = await login(app, password);
    const invoiceId = await createInvoice(app, sid, 100);

    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
      payload: { amount: 100, txnDate: '2026-07-05' },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('pushes the invoice + payment outbound when a QBO connection is configured', async () => {
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
    const invoiceId = await createInvoice(app, sid, 100);

    const res = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
      payload: { amount: 100, txnDate: '2026-07-05' },
    });
    expect(res.statusCode).toBe(201);

    // Invoice create route already pushed the Invoice; the payment route pushes the Payment.
    expect(client.countOf('create', 'Invoice')).toBe(1);
    expect(client.countOf('create', 'Payment')).toBe(1);

    const paymentId = (res.json() as { payment: { id: string } }).payment.id;
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/payments/${paymentId}`,
      cookies: { __session: sid },
    });
    expect(getRes.statusCode).toBe(200);

    await app.close();
  });

  it('void: pushes a QBO void for a previously-synced payment', async () => {
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
    const invoiceId = await createInvoice(app, sid, 100);

    const paymentRes = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
      payload: { amount: 100, txnDate: '2026-07-05' },
    });
    const paymentId = (paymentRes.json() as { payment: { id: string } }).payment.id;

    const voidRes = await app.inject({
      method: 'POST',
      url: `/api/payments/${paymentId}/void`,
      cookies: { __session: sid },
    });
    expect(voidRes.statusCode).toBe(200);
    expect(client.countOf('void', 'Payment')).toBe(1);

    await app.close();
  });

  it('delete: pushes a QBO delete (not a void) for a previously-synced payment — outbound headline distinction (20009)', async () => {
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
    const invoiceId = await createInvoice(app, sid, 100);

    const paymentRes = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { __session: sid },
      payload: { amount: 100, txnDate: '2026-07-05' },
    });
    const paymentId = (paymentRes.json() as { payment: { id: string } }).payment.id;

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/payments/${paymentId}`,
      cookies: { __session: sid },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(client.countOf('delete', 'Payment')).toBe(1);
    expect(client.countOf('void', 'Payment')).toBe(0);

    await app.close();
  });
});
