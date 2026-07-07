import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import { buildApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import { accounts, users } from '../db/schema.ts';

let testDb: TestDb | undefined;

afterEach(async () => {
  await testDb?.cleanup();
  testDb = undefined;
});

async function seedOrgAndAdmin(email: string, orgName: string) {
  if (!testDb) testDb = await createTestDb();
  const { orgId } = await seedBaseOrg(testDb.db, { name: orgName });
  const password = 'correct horse battery staple';
  const [admin] = await testDb.db
    .insert(users)
    .values({ orgId, email, passwordHash: await hashPassword(password), role: 'admin' })
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

async function login(app: ReturnType<typeof buildApp>, email: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
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

async function createInvoice(
  app: ReturnType<typeof buildApp>,
  sid: string,
  contactId: string,
  unitPrice: number,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/invoices',
    cookies: { sid },
    payload: { contactId, txnDate: '2026-07-04', lines: [{ quantity: 1, unitPrice }] },
  });
  return (res.json() as { id: string }).id;
}

function app() {
  if (!testDb) throw new Error('unreachable');
  return buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
}

describe('GET /api/invoices/:id/ledger', () => {
  it('returns the balanced debit/credit postings for a freshly created invoice', async () => {
    const { password } = await seedOrgAndAdmin('admin1@example.test', 'Org A');
    const a = app();
    const sid = await login(a, 'admin1@example.test', password);
    const contactId = await createCustomer(a, sid);
    const invoiceId = await createInvoice(a, sid, contactId, 100);

    const res = await a.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}/ledger`,
      cookies: { sid },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entries: Array<{
        accountName: string;
        accountSubtype: string | null;
        debit: string;
        credit: string;
      }>;
      totalDebit: string;
      totalCredit: string;
    };
    expect(body.entries).toHaveLength(2);
    expect(body.totalDebit).toBe('100.00');
    expect(body.totalCredit).toBe('100.00');

    const ar = body.entries.find((e) => e.accountSubtype === 'accounts_receivable');
    expect(ar).toBeDefined();
    expect(ar?.accountName).toBe('Accounts Receivable');
    expect(ar?.debit).toBe('100.00');
    expect(ar?.credit).toBe('0.00');

    const income = body.entries.find((e) => e.accountSubtype === 'sales_income');
    expect(income).toBeDefined();
    expect(income?.accountName).toBe('Sales Income');
    expect(income?.credit).toBe('100.00');
    expect(income?.debit).toBe('0.00');

    await a.close();
  });

  it('orders entries by entryDate then createdAt across an edit that changes the posting date', async () => {
    const { password } = await seedOrgAndAdmin('admin-order@example.test', 'Org Order');
    const a = app();
    const sid = await login(a, 'admin-order@example.test', password);
    const contactId = await createCustomer(a, sid);
    const invoiceId = await createInvoice(a, sid, contactId, 50);

    // Push the txnDate forward — the original creation posting stays dated 2026-07-04 (ledger
    // entries are append-only, never rewritten), while the edit's reversal + re-post land on the
    // new 2026-07-10 date, so the read must return entries sorted oldest-entryDate-first.
    const editRes = await a.inject({
      method: 'PATCH',
      url: `/api/invoices/${invoiceId}`,
      cookies: { sid },
      payload: { txnDate: '2026-07-10' },
    });
    expect(editRes.statusCode).toBe(200);

    const res = await a.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}/ledger`,
      cookies: { sid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: Array<{ entryDate: string }>; totalDebit: string };
    expect(body.entries.length).toBeGreaterThanOrEqual(2);
    const dates = body.entries.map((e) => e.entryDate);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);

    await a.close();
  });

  it('nets debits and credits to a balanced zero-movement history after a void', async () => {
    const { password } = await seedOrgAndAdmin('admin2@example.test', 'Org B');
    const a = app();
    const sid = await login(a, 'admin2@example.test', password);
    const contactId = await createCustomer(a, sid);
    const invoiceId = await createInvoice(a, sid, contactId, 75);

    const voidRes = await a.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/void`,
      cookies: { sid },
    });
    expect(voidRes.statusCode).toBe(200);

    const res = await a.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}/ledger`,
      cookies: { sid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: unknown[]; totalDebit: string; totalCredit: string };
    // Original posting (debit A/R + credit income) plus the reversing entries.
    expect(body.entries).toHaveLength(4);
    expect(body.totalDebit).toBe(body.totalCredit);
    expect(body.totalDebit).toBe('150.00');

    await a.close();
  });

  it("does not surface a payment's own postings (they belong to the payment's transaction, not the invoice's)", async () => {
    const { password } = await seedOrgAndAdmin('admin3@example.test', 'Org C');
    const a = app();
    const sid = await login(a, 'admin3@example.test', password);
    const contactId = await createCustomer(a, sid);
    const invoiceId = await createInvoice(a, sid, contactId, 100);

    const paymentRes = await a.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payments`,
      cookies: { sid },
      payload: { amount: 40, txnDate: '2026-07-05' },
    });
    expect(paymentRes.statusCode).toBe(201);

    const res = await a.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}/ledger`,
      cookies: { sid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: unknown[]; totalDebit: string; totalCredit: string };
    // The invoice's own ledger is unaffected by the payment — postLedger for a payment posts
    // against the payment's own transactionId (apps/api/src/payments/service.ts), not the
    // invoice's. Still balanced, still just the original 2 rows.
    expect(body.entries).toHaveLength(2);
    expect(body.totalDebit).toBe('100.00');
    expect(body.totalCredit).toBe('100.00');

    await a.close();
  });

  it('returns 404 for an invoice belonging to a different org', async () => {
    const { password: passwordA } = await seedOrgAndAdmin('admin-a@example.test', 'Org Cross A');
    const a = app();
    const sidA = await login(a, 'admin-a@example.test', passwordA);
    const contactId = await createCustomer(a, sidA);
    const invoiceId = await createInvoice(a, sidA, contactId, 60);
    await a.close();

    const { password: passwordB } = await seedOrgAndAdmin('admin-b@example.test', 'Org Cross B');
    const b = app();
    const sidB = await login(b, 'admin-b@example.test', passwordB);

    const res = await b.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}/ledger`,
      cookies: { sid: sidB },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });

    await b.close();
  });

  it('returns 404 for a soft-deleted invoice, matching GET /:id', async () => {
    const { password } = await seedOrgAndAdmin('admin4@example.test', 'Org D');
    const a = app();
    const sid = await login(a, 'admin4@example.test', password);
    const contactId = await createCustomer(a, sid);
    const invoiceId = await createInvoice(a, sid, contactId, 30);

    const deleteRes = await a.inject({
      method: 'DELETE',
      url: `/api/invoices/${invoiceId}`,
      cookies: { sid },
    });
    expect(deleteRes.statusCode).toBe(200);

    const res = await a.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}/ledger`,
      cookies: { sid },
    });
    expect(res.statusCode).toBe(404);

    await a.close();
  });

  it('returns 401 without a session', async () => {
    const { password } = await seedOrgAndAdmin('admin5@example.test', 'Org E');
    const a = app();
    const sid = await login(a, 'admin5@example.test', password);
    const contactId = await createCustomer(a, sid);
    const invoiceId = await createInvoice(a, sid, contactId, 20);

    const res = await a.inject({ method: 'GET', url: `/api/invoices/${invoiceId}/ledger` });
    expect(res.statusCode).toBe(401);

    await a.close();
  });

  it('returns 404 for a nonexistent invoice id', async () => {
    const { password } = await seedOrgAndAdmin('admin6@example.test', 'Org F');
    const a = app();
    const sid = await login(a, 'admin6@example.test', password);

    const res = await a.inject({
      method: 'GET',
      url: '/api/invoices/00000000-0000-0000-0000-000000000000/ledger',
      cookies: { sid },
    });
    expect(res.statusCode).toBe(404);

    await a.close();
  });
});
