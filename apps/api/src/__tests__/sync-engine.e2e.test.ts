// 20013 — Sync engine end-to-end edge-case suite. This drives each of the PRD's eight named
// sync-engine edge cases through the REAL entry points (the signed webhook route, the
// invoice/payment HTTP routes, the outbound retry sweep) against real Postgres (pglite, via
// `createTestDb()`) with the injectable fake QBO clients already established by 20005-20011's own
// suites (`fakeApiClient`/`sign` pattern from `routes/qbo-webhook.test.ts`,
// `createFakeQboWriteClient` from `__tests__/helpers/fake-qbo-write-client.ts`,
// `runOutboundRetrySweep` from `qbo/retry-sweep.test.ts`) — see `.claude/plans/20013-sync-engine-
// tests.md`. Test-only: no production file is touched by this task.
//
// Every scenario asserts PERSISTED state (queried straight from the tables), the AUDIT trail
// (`sync_audit_logs`), and QBO call counts (`client.countOf(...)`) — never just a response shape —
// so a reverted engine guard would make the assertion fail, not merely change a status code.

import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import {
  accounts,
  contacts,
  ledgerEntries,
  syncAuditLogs,
  transactions,
  users,
} from '../db/schema.ts';
import { createInvoice } from '../invoices/service.ts';
import type { QboApiClient, QboEntityEnvelope, QboEntityType } from '../qbo/api-client.ts';
import { upsertConnection } from '../qbo/connection-service.ts';
import type { QboOAuthClient, QboTokenResult } from '../qbo/oauth-client.ts';
import { runOutboundRetrySweep } from '../qbo/retry-sweep.ts';
import { findLinkByLocal, findLinkByQbo, markFailed } from '../qbo/sync-link-service.ts';
import { createFakeQboWriteClient } from './helpers/fake-qbo-write-client.ts';
import { createTestDb, seedBaseOrg, type TestDb } from './helpers/test-db.ts';

// ---------------------------------------------------------------------------
// Shared fixtures / helpers (kept local — nothing here is reused outside this one file, so
// extracting a separate `helpers/webhook.ts` per the plan's §1 would not remove any real
// duplication).
// ---------------------------------------------------------------------------

const VERIFIER_TOKEN = 'e2e-verifier';

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

function sign(body: string, token = VERIFIER_TOKEN): string {
  return createHmac('sha256', token).update(body, 'utf8').digest('base64');
}

interface WebhookEntityInput {
  name: string;
  id: string;
  operation: string;
  lastUpdated?: string;
}

async function postWebhook(
  app: ReturnType<typeof buildApp>,
  realmId: string,
  entities: WebhookEntityInput[],
) {
  const body = JSON.stringify({ eventNotifications: [{ realmId, dataChangeEvent: { entities } }] });
  return app.inject({
    method: 'POST',
    url: '/api/integrations/qbo/webhook',
    headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
    payload: body,
  });
}

/** A read-only fake whose `getEntity` returns whatever was last staged via `setNext` — lets a
 * test drive several distinct webhook deliveries against the same client instance while
 * controlling exactly what the "authoritative QBO refetch" returns each time, without needing a
 * write-capable client's own bookkeeping. Write methods are never expected to be called by the
 * inbound-only scenarios that use this. */
function stagedReadClient(): {
  client: QboApiClient;
  setNext: (entityType: QboEntityType, body: Record<string, unknown>) => void;
} {
  let staged: { entityType: QboEntityType; body: Record<string, unknown> } | null = null;
  const client: QboApiClient = {
    getEntity: vi.fn(async () => {
      if (!staged) throw new Error('stagedReadClient: no staged entity set before a refetch');
      return { [staged.entityType]: staged.body } as QboEntityEnvelope;
    }),
    createEntity: vi.fn(async () => {
      throw new Error('stagedReadClient: createEntity not used by inbound-only scenarios');
    }),
    updateEntity: vi.fn(async () => {
      throw new Error('stagedReadClient: updateEntity not used by inbound-only scenarios');
    }),
    voidEntity: vi.fn(async () => {
      throw new Error('stagedReadClient: voidEntity not used by inbound-only scenarios');
    }),
    deleteEntity: vi.fn(async () => {
      throw new Error('stagedReadClient: deleteEntity not used by inbound-only scenarios');
    }),
  };
  return {
    client,
    setNext(entityType, body) {
      staged = { entityType, body };
    },
  };
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

async function createCustomer(
  app: ReturnType<typeof buildApp>,
  sid: string,
  displayName = 'Acme Co',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/contacts',
    cookies: { __session: sid },
    payload: {
      displayName,
      email: `${displayName.toLowerCase().replace(/\s+/g, '-')}@example.test`,
    },
  });
  return (res.json() as { id: string }).id;
}

/** HTTP-flow fixture: an org, an admin user (real hashed password so tests can log in over
 * `/api/auth/login`), and the chart-of-accounts subtypes every invoice/payment route needs
 * (`accounts_receivable`, `sales_income`, `undeposited_funds`). Used by every scenario that drives
 * the pipeline via `app.inject` HTTP routes. */
async function seedOrgAndAdmin(db: TestDb['db']) {
  const { orgId } = await seedBaseOrg(db);
  const password = 'correct horse battery staple';
  await db.insert(users).values({
    orgId,
    email: 'admin@example.test',
    passwordHash: await hashPassword(password),
    role: 'admin',
  });
  await db.insert(accounts).values([
    { orgId, name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
    { orgId, name: 'Sales Income', type: 'income', subtype: 'sales_income' },
    { orgId, name: 'Undeposited Funds', type: 'asset', subtype: 'undeposited_funds' },
  ]);
  return { orgId, password };
}

/** Direct-service fixture for the outbound-retry scenarios (6/7), mirroring
 * `qbo/retry-sweep.test.ts`'s own `seedOrg`/`seedInvoice` helpers — those scenarios need to
 * construct a specific partial-success DB state that isn't reachable by timing an HTTP request,
 * per the plan's own guidance ("Realize it as: a `failed` link with `qboId=null` ... plus the
 * matching entity present in the fake QBO store"). */
async function seedOrgWithChart(db: TestDb['db']) {
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
  return { orgId, userId: user.id };
}

async function seedQboConnection(db: TestDb['db'], orgId: string, realmId: string): Promise<void> {
  await upsertConnection(db, orgId, { ...TOKENS, realmId });
}

async function sumLedgerNetByAccount(
  db: TestDb['db'],
  orgId: string,
  transactionId: string,
): Promise<number[]> {
  const rows = await db
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.orgId, orgId), eq(ledgerEntries.transactionId, transactionId)));
  const netByAccount = new Map<string, number>();
  for (const row of rows) {
    const net = Number(row.debit) - Number(row.credit);
    netByAccount.set(row.accountId, (netByAccount.get(row.accountId) ?? 0) + net);
  }
  return [...netByAccount.values()];
}

let testDb: TestDb | undefined;

afterEach(async () => {
  await testDb?.cleanup();
  testDb = undefined;
});

describe('sync engine — end-to-end edge cases (20013)', () => {
  // -------------------------------------------------------------------------
  // 1. Duplicate webhook
  // -------------------------------------------------------------------------
  describe('1. duplicate webhook', () => {
    it('a redelivered identical event applies once; the second delivery is a byte-identical no-op', async () => {
      testDb = await createTestDb();
      const REALM = 'realm-dup';
      const { orgId, password } = await seedOrgAndAdmin(testDb.db);
      await seedQboConnection(testDb.db, orgId, REALM);

      const writeClient = createFakeQboWriteClient();
      const app1 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: writeClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const sid = await login(app1, password);
      const contactId = await createCustomer(app1, sid);
      const createRes = await app1.inject({
        method: 'POST',
        url: '/api/invoices',
        cookies: { __session: sid },
        payload: {
          contactId,
          txnDate: '2026-07-01',
          docNumber: 'DUP-1',
          lines: [{ quantity: 1, unitPrice: 100 }],
        },
      });
      const invoiceId = (createRes.json() as { id: string }).id;
      const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      if (!link?.qboId) throw new Error('setup: expected the invoice to be linked after create');
      const qboId = link.qboId;
      await app1.close();

      const { client: readClient, setNext } = stagedReadClient();
      setNext('Invoice', { Id: qboId, SyncToken: '1', PrivateNote: 'first-apply' });
      const app2 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: readClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });

      const firstRes = await postWebhook(app2, REALM, [
        { name: 'Invoice', id: qboId, operation: 'Update', lastUpdated: '2026-07-02T00:00:00Z' },
      ]);
      expect(firstRes.statusCode).toBe(200);

      const [afterFirst] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceId));
      expect(afterFirst?.memo).toBe('first-apply');

      // Identical redelivery: same realm/entity/operation/lastUpdated -> same event key.
      const secondRes = await postWebhook(app2, REALM, [
        { name: 'Invoice', id: qboId, operation: 'Update', lastUpdated: '2026-07-02T00:00:00Z' },
      ]);
      expect(secondRes.statusCode).toBe(200);

      const [afterSecond] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceId));
      // Anti-tautology: asserts the actual persisted content is unchanged, not merely a flag.
      expect(afterSecond?.memo).toBe('first-apply');
      expect(afterSecond?.version).toBe(afterFirst?.version);

      const auditRows = await testDb.db
        .select()
        .from(syncAuditLogs)
        .where(and(eq(syncAuditLogs.orgId, orgId), eq(syncAuditLogs.direction, 'inbound')));
      const applied = auditRows.filter((r) => r.action === 'qbo.inbound.update');
      const duplicates = auditRows.filter((r) => r.action === 'qbo.webhook.duplicate');
      expect(applied).toHaveLength(1);
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]).toMatchObject({ outcome: 'skipped', direction: 'inbound' });

      await app2.close();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Out-of-order events
  // -------------------------------------------------------------------------
  describe('2. out-of-order events', () => {
    it('a stale (lower SyncToken) delivery is skipped without downgrading the stored token; a genuinely newer one still applies', async () => {
      testDb = await createTestDb();
      const REALM = 'realm-ordering';
      const { orgId, password } = await seedOrgAndAdmin(testDb.db);
      await seedQboConnection(testDb.db, orgId, REALM);

      const writeClient = createFakeQboWriteClient();
      const app1 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: writeClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const sid = await login(app1, password);
      const contactId = await createCustomer(app1, sid);
      const createRes = await app1.inject({
        method: 'POST',
        url: '/api/invoices',
        cookies: { __session: sid },
        payload: {
          contactId,
          txnDate: '2026-07-01',
          docNumber: 'ORD-1',
          lines: [{ quantity: 1, unitPrice: 100 }],
        },
      });
      const invoiceId = (createRes.json() as { id: string }).id;
      const link0 = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      if (!link0?.qboId) throw new Error('setup: expected the invoice to be linked after create');
      const qboId = link0.qboId;
      expect(link0.qboSyncToken).toBe('0'); // the fake client's create() stamps token 0
      await app1.close();

      const { client: readClient, setNext } = stagedReadClient();
      const app2 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: readClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });

      // Move the recorded state forward to token 2 first, so the "stale" delivery below (token 1)
      // is unambiguously older than what's ALREADY recorded, not just older than the create.
      setNext('Invoice', { Id: qboId, SyncToken: '2', PrivateNote: 'advance-to-2' });
      const advanceRes = await postWebhook(app2, REALM, [
        { name: 'Invoice', id: qboId, operation: 'Update', lastUpdated: '2026-07-02T00:00:00Z' },
      ]);
      expect(advanceRes.statusCode).toBe(200);
      let link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      expect(link?.qboSyncToken).toBe('2');

      // Stale delivery: incoming token 1 <= stored token 2 -> must be skipped, must not downgrade.
      setNext('Invoice', { Id: qboId, SyncToken: '1', PrivateNote: 'stale-attempt' });
      const staleRes = await postWebhook(app2, REALM, [
        { name: 'Invoice', id: qboId, operation: 'Update', lastUpdated: '2026-07-03T00:00:00Z' },
      ]);
      expect(staleRes.statusCode).toBe(200);

      const [afterStale] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceId));
      expect(afterStale?.memo).toBe('advance-to-2'); // unchanged — the stale note never applied
      link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      expect(link?.qboSyncToken).toBe('2'); // not downgraded to '1'

      const staleAudit = await testDb.db
        .select()
        .from(syncAuditLogs)
        .where(and(eq(syncAuditLogs.orgId, orgId), eq(syncAuditLogs.action, 'qbo.inbound.skip')));
      expect(
        staleAudit.some((r) => (r.detail as { reason?: string })?.reason === 'stale_ignored'),
      ).toBe(true);

      // Genuinely newer delivery: token 5 > stored token 2 -> applies.
      setNext('Invoice', { Id: qboId, SyncToken: '5', PrivateNote: 'newer-apply' });
      const newerRes = await postWebhook(app2, REALM, [
        { name: 'Invoice', id: qboId, operation: 'Update', lastUpdated: '2026-07-04T00:00:00Z' },
      ]);
      expect(newerRes.statusCode).toBe(200);

      const [afterNewer] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceId));
      expect(afterNewer?.memo).toBe('newer-apply');
      link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      expect(link?.qboSyncToken).toBe('5');

      await app2.close();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Edited in both systems (conflict)
  // -------------------------------------------------------------------------
  describe('3. edited in both systems', () => {
    it('a local edit + a genuinely newer inbound update raises a conflict, applies neither side, and blocks the next outbound push', async () => {
      testDb = await createTestDb();
      const REALM = 'realm-conflict';
      const { orgId, password } = await seedOrgAndAdmin(testDb.db);
      await seedQboConnection(testDb.db, orgId, REALM);

      const writeClientA = createFakeQboWriteClient();
      const app1 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: writeClientA,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const sid = await login(app1, password);
      const contactId = await createCustomer(app1, sid);
      const createRes = await app1.inject({
        method: 'POST',
        url: '/api/invoices',
        cookies: { __session: sid },
        payload: {
          contactId,
          txnDate: '2026-07-01',
          docNumber: 'CONFLICT-1',
          lines: [{ quantity: 1, unitPrice: 100 }],
        },
      });
      const invoiceId = (createRes.json() as { id: string }).id;
      const link0 = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      if (!link0?.qboId) throw new Error('setup: expected the invoice to be linked after create');
      const qboId = link0.qboId;
      expect(link0.localVersion).toBe(0);
      await app1.close();

      // Local edit with QBO disconnected (deps null -> outbound push is a pure no-op) — the
      // divergence the scenario needs: txn.version bumps, the link's recorded localVersion does
      // not move.
      const app2 = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
      const editRes = await app2.inject({
        method: 'PATCH',
        url: `/api/invoices/${invoiceId}`,
        cookies: { __session: sid },
        payload: { memo: 'local edit while offline' },
      });
      expect(editRes.statusCode).toBe(200);
      expect(editRes.json().version).toBe(1);
      await app2.close();
      const linkAfterEdit = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      expect(linkAfterEdit?.localVersion).toBe(0); // untouched by the no-op push
      expect(linkAfterEdit?.state).toBe('synced'); // not yet conflicted

      // Inbound: QBO genuinely changed too (SyncToken 1 > stored 0) — both sides moved.
      const { client: readClient, setNext } = stagedReadClient();
      setNext('Invoice', { Id: qboId, SyncToken: '1', PrivateNote: 'changed-in-qbo-too' });
      const app3 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: readClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const webhookRes = await postWebhook(app3, REALM, [
        { name: 'Invoice', id: qboId, operation: 'Update', lastUpdated: '2026-07-02T00:00:00Z' },
      ]);
      expect(webhookRes.statusCode).toBe(200);
      await app3.close();

      const [afterConflict] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceId));
      // Neither side's edit applied — the local edit stands, the QBO note was never written.
      expect(afterConflict?.memo).toBe('local edit while offline');

      const conflictLink = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      expect(conflictLink?.state).toBe('conflict');
      expect(conflictLink?.conflictDetectedAt).not.toBeNull();

      const conflictAudit = await testDb.db
        .select()
        .from(syncAuditLogs)
        .where(
          and(eq(syncAuditLogs.orgId, orgId), eq(syncAuditLogs.action, 'qbo.inbound.conflict')),
        );
      expect(conflictAudit).toHaveLength(1);
      expect(conflictAudit[0]).toMatchObject({ outcome: 'skipped', direction: 'inbound' });
      expect((conflictAudit[0]?.detail as { reason?: string })?.reason).toBe('both_sides_changed');

      // A SUBSEQUENT outbound trigger must be blocked before it ever touches QBO — a fresh client
      // proves it: zero calls of ANY kind, not just zero updates.
      const freshClient = createFakeQboWriteClient();
      const app4 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: freshClient,
      });
      const secondEditRes = await app4.inject({
        method: 'PATCH',
        url: `/api/invoices/${invoiceId}`,
        cookies: { __session: sid },
        payload: { memo: 'trying again while conflicted' },
      });
      expect(secondEditRes.statusCode).toBe(200); // the local edit itself is never blocked
      expect(freshClient.calls).toHaveLength(0); // anti-tautology: proves NO push was attempted
      expect(freshClient.countOf('update', 'Invoice')).toBe(0);

      const blockedAudit = await testDb.db
        .select()
        .from(syncAuditLogs)
        .where(
          and(
            eq(syncAuditLogs.orgId, orgId),
            eq(syncAuditLogs.action, 'outbound_sync'),
            eq(syncAuditLogs.outcome, 'skipped'),
          ),
        );
      expect(
        blockedAudit.some((r) => (r.detail as { reason?: string })?.reason === 'conflict_blocked'),
      ).toBe(true);

      const linkAfterBlock = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      expect(linkAfterBlock?.state).toBe('conflict'); // still held
      expect(linkAfterBlock?.localVersion).toBe(0); // untouched by the blocked push

      await app4.close();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Delete vs void (distinct persisted states)
  // -------------------------------------------------------------------------
  describe('4. delete vs void', () => {
    it('inbound Void zeroes the ledger and flips status; inbound Delete soft-deletes without touching status — the two never collapse', async () => {
      testDb = await createTestDb();
      const REALM = 'realm-delete-void';
      const { orgId, password } = await seedOrgAndAdmin(testDb.db);
      await seedQboConnection(testDb.db, orgId, REALM);

      const writeClient = createFakeQboWriteClient();
      const app1 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: writeClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const sid = await login(app1, password);
      const contactId = await createCustomer(app1, sid);

      const invAResp = await app1.inject({
        method: 'POST',
        url: '/api/invoices',
        cookies: { __session: sid },
        payload: {
          contactId,
          txnDate: '2026-07-01',
          docNumber: 'DV-A',
          lines: [{ quantity: 1, unitPrice: 100 }],
        },
      });
      const invoiceAId = (invAResp.json() as { id: string }).id;
      const invBResp = await app1.inject({
        method: 'POST',
        url: '/api/invoices',
        cookies: { __session: sid },
        payload: {
          contactId,
          txnDate: '2026-07-01',
          docNumber: 'DV-B',
          lines: [{ quantity: 1, unitPrice: 200 }],
        },
      });
      const invoiceBId = (invBResp.json() as { id: string }).id;

      const linkA = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceAId);
      const linkB = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceBId);
      if (!linkA?.qboId || !linkB?.qboId) throw new Error('setup: expected both invoices linked');
      const qboIdA = linkA.qboId;
      const qboIdB = linkB.qboId;
      await app1.close();

      const { client: readClient, setNext } = stagedReadClient();
      const app2 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: readClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });

      // (a) Inbound Void on invoice A.
      setNext('Invoice', { Id: qboIdA, SyncToken: '1' });
      const voidRes = await postWebhook(app2, REALM, [
        { name: 'Invoice', id: qboIdA, operation: 'Void', lastUpdated: '2026-07-02T00:00:00Z' },
      ]);
      expect(voidRes.statusCode).toBe(200);

      const [invoiceAAfter] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceAId));
      expect(invoiceAAfter?.status).toBe('void');
      expect(invoiceAAfter?.balance).toBe('0.00');
      expect(invoiceAAfter?.deletedAt).toBeNull();
      const netsA = await sumLedgerNetByAccount(testDb.db, orgId, invoiceAId);
      expect(netsA.every((n) => n === 0)).toBe(true); // ledger net zero
      const linkAAfter = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceAId);
      expect(linkAAfter?.state).toBe('synced'); // link retained, not dropped
      expect(linkAAfter?.qboId).toBe(qboIdA);

      // A voided invoice is still individually readable (distinct from delete's 404 below).
      const getVoidRes = await app2.inject({
        method: 'GET',
        url: `/api/invoices/${invoiceAId}`,
        cookies: { __session: sid },
      });
      expect(getVoidRes.statusCode).toBe(200);
      expect(getVoidRes.json().status).toBe('void');

      // (b) Inbound Delete on invoice B.
      setNext('Invoice', { Id: qboIdB, SyncToken: '1' });
      const deleteRes = await postWebhook(app2, REALM, [
        { name: 'Invoice', id: qboIdB, operation: 'Delete', lastUpdated: '2026-07-03T00:00:00Z' },
      ]);
      expect(deleteRes.statusCode).toBe(200);

      const [invoiceBAfter] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceBId));
      expect(invoiceBAfter?.deletedAt).not.toBeNull();
      expect(invoiceBAfter?.balance).toBe('0.00');
      // The headline distinction: delete does NOT flip status to 'void' — void and delete are
      // orthogonal local states, never collapsed to the same thing.
      expect(invoiceBAfter?.status).not.toBe('void');
      const netsB = await sumLedgerNetByAccount(testDb.db, orgId, invoiceBId);
      expect(netsB.every((n) => n === 0)).toBe(true);
      const linkBAfter = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceBId);
      expect(linkBAfter?.state).toBe('synced'); // link retained (20009: prevents re-link/resurrect)
      expect(linkBAfter?.qboId).toBe(qboIdB);

      // A soft-deleted invoice 404s on single-read and vanishes from the list.
      const getDeletedRes = await app2.inject({
        method: 'GET',
        url: `/api/invoices/${invoiceBId}`,
        cookies: { __session: sid },
      });
      expect(getDeletedRes.statusCode).toBe(404);
      const listRes = await app2.inject({
        method: 'GET',
        url: '/api/invoices',
        cookies: { __session: sid },
      });
      const listIds = (listRes.json() as Array<{ id: string }>).map((r) => r.id);
      expect(listIds).not.toContain(invoiceBId);
      expect(listIds).toContain(invoiceAId); // the void one is still listed

      // A later inbound event on the deleted invoice must not resurrect it (terminal state).
      setNext('Invoice', { Id: qboIdB, SyncToken: '2', DocNumber: 'DV-B-RENAMED' });
      const afterDeleteUpdateRes = await postWebhook(app2, REALM, [
        { name: 'Invoice', id: qboIdB, operation: 'Update', lastUpdated: '2026-07-04T00:00:00Z' },
      ]);
      expect(afterDeleteUpdateRes.statusCode).toBe(200);
      const [invoiceBStillDeleted] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceBId));
      expect(invoiceBStillDeleted?.deletedAt).not.toBeNull();
      expect(invoiceBStillDeleted?.docNumber).toBe('DV-B'); // metadata patch never applied
      const orgInvoiceCount = await testDb.db
        .select()
        .from(transactions)
        .where(and(eq(transactions.orgId, orgId), eq(transactions.type, 'customer_invoice')));
      expect(orgInvoiceCount).toHaveLength(2); // no third (resurrected/duplicated) row

      const alreadyDeletedAudit = await testDb.db
        .select()
        .from(syncAuditLogs)
        .where(and(eq(syncAuditLogs.orgId, orgId), eq(syncAuditLogs.localId, invoiceBId)));
      expect(
        alreadyDeletedAudit.some(
          (r) =>
            r.action === 'qbo.inbound.skip' &&
            (r.detail as { reason?: string })?.reason === 'already_deleted',
        ),
      ).toBe(true);

      await app2.close();
    });
  });

  // -------------------------------------------------------------------------
  // 4b. Inbound QBO amount edit (30015) — Line/amount re-sync, not just metadata
  // -------------------------------------------------------------------------
  describe('4b. inbound QBO amount edit re-syncs local lines + ledger', () => {
    it('a QBO Line/TotalAmt edit delivered over the real webhook route re-posts the local ledger balanced at the new total', async () => {
      testDb = await createTestDb();
      const REALM = 'realm-amount-edit';
      const { orgId, password } = await seedOrgAndAdmin(testDb.db);
      await seedQboConnection(testDb.db, orgId, REALM);

      const writeClient = createFakeQboWriteClient();
      const app1 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: writeClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const sid = await login(app1, password);
      const contactId = await createCustomer(app1, sid);
      const createRes = await app1.inject({
        method: 'POST',
        url: '/api/invoices',
        cookies: { __session: sid },
        payload: {
          contactId,
          txnDate: '2026-07-01',
          docNumber: 'AMT-1',
          lines: [{ quantity: 1, unitPrice: 100 }],
        },
      });
      const invoiceId = (createRes.json() as { id: string }).id;
      const link0 = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      if (!link0?.qboId) throw new Error('setup: expected the invoice to be linked after create');
      const qboId = link0.qboId;
      await app1.close();

      // QBO-side edit: the amount changes from 100.00 to 175.00 (a due-date-style metadata edit
      // would already sync per the pre-30015 baseline — this is the case that previously did not:
      // a Line/TotalAmt edit).
      const { client: readClient, setNext } = stagedReadClient();
      setNext('Invoice', {
        Id: qboId,
        SyncToken: '1',
        DocNumber: 'AMT-1',
        Line: [
          {
            Amount: 175,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: { Qty: 1, UnitPrice: 175 },
          },
        ],
      });
      const app2 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: readClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const webhookRes = await postWebhook(app2, REALM, [
        { name: 'Invoice', id: qboId, operation: 'Update', lastUpdated: '2026-07-02T00:00:00Z' },
      ]);
      expect(webhookRes.statusCode).toBe(200);

      const [afterAmountEdit] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceId));
      // The headline fix: an amount edit now reaches the local ledger, not just metadata.
      expect(afterAmountEdit?.total).toBe('175.00');
      expect(afterAmountEdit?.balance).toBe('175.00');
      expect(afterAmountEdit?.status).toBe('open');

      const nets = await sumLedgerNetByAccount(testDb.db, orgId, invoiceId);
      // Balanced (debits net to the same magnitude as credits) at the NEW total, not the old one —
      // proves this is a real re-post, not a stale/half-applied ledger.
      expect(nets.reduce((sum, n) => sum + n, 0)).toBe(0);
      expect(nets.some((n) => n === 175)).toBe(true);

      const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      expect(link?.qboSyncToken).toBe('1');

      // GET reflects the re-synced amount too — the fix is visible end-to-end, not just in the DB.
      const getRes = await app2.inject({
        method: 'GET',
        url: `/api/invoices/${invoiceId}`,
        cookies: { __session: sid },
      });
      expect(getRes.json().total).toBe('175.00');

      await app2.close();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Partially-paid invoice edited
  // -------------------------------------------------------------------------
  describe('5. partially-paid invoice edited', () => {
    it('a local edit attempt is rejected with 409 and a subsequent genuinely-newer inbound update is conflict-blocked (the payment left the invoice locally dirty), leaving the ledger untouched', async () => {
      testDb = await createTestDb();
      const REALM = 'realm-partial-paid';
      const { orgId, password } = await seedOrgAndAdmin(testDb.db);
      await seedQboConnection(testDb.db, orgId, REALM);

      const writeClient = createFakeQboWriteClient();
      const app1 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: writeClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const sid = await login(app1, password);
      const contactId = await createCustomer(app1, sid);
      const createRes = await app1.inject({
        method: 'POST',
        url: '/api/invoices',
        cookies: { __session: sid },
        payload: {
          contactId,
          txnDate: '2026-07-01',
          docNumber: 'PP-1',
          lines: [{ quantity: 1, unitPrice: 100 }],
        },
      });
      const invoiceId = (createRes.json() as { id: string }).id;
      const link0 = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      if (!link0?.qboId) throw new Error('setup: expected the invoice to be linked after create');
      const qboId = link0.qboId;

      const paymentRes = await app1.inject({
        method: 'POST',
        url: `/api/invoices/${invoiceId}/payments`,
        cookies: { __session: sid },
        payload: { amount: 40, txnDate: '2026-07-05' },
      });
      expect(paymentRes.statusCode).toBe(201);
      expect(paymentRes.json().invoice).toMatchObject({
        status: 'partially_paid',
        balance: '60.00',
      });
      await app1.close();

      // (a) Local edit attempt on a partially-paid invoice -> 409, nothing touched.
      const app2 = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
      const editRes = await app2.inject({
        method: 'PATCH',
        url: `/api/invoices/${invoiceId}`,
        cookies: { __session: sid },
        payload: { memo: 'should be rejected' },
      });
      expect(editRes.statusCode).toBe(409);
      expect(editRes.json().error).toBe('invalid_state');
      const [afterRejectedEdit] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceId));
      expect(afterRejectedEdit?.status).toBe('partially_paid');
      expect(afterRejectedEdit?.balance).toBe('60.00');
      expect(afterRejectedEdit?.memo).not.toBe('should be rejected');
      await app2.close();

      // (b) Inbound QBO metadata update (DocNumber/DueDate only) after the payment.
      //
      // NOTE ON PLAN vs. ACTUAL BEHAVIOR (flagged to the planner, no production file touched):
      // the plan's §2.5(b) expected this to apply cleanly ("metadata only... status and balance
      // unchanged"). It does NOT — and per `docs/design-decisions.md` ## Conflict resolution this
      // is the correct, already-reviewed (20010) behavior, not an engine bug: `recordPayment`'s
      // `recomputeInvoice` bumps the INVOICE's own `transactions.version` (status/balance
      // recompute), but only the PAYMENT's own link gets pushed/resynced afterward — the
      // invoice's `sync_links.localVersion` snapshot is never refreshed (no route re-pushes the
      // invoice itself while it's `partially_paid`; PATCH is blocked by (a) above, and
      // void/delete both require `status==='open'`). So the invoice is permanently "one version
      // behind" its own link once a payment lands, and the conflict detector's documented
      // invariant — "the local side changed since last sync" is true whether that change was an
      // edit, a payment, a void, or a delete — correctly treats ANY subsequent genuinely-newer
      // inbound QBO change to this same invoice as both-sides-changed, not a clean apply. This
      // test asserts that actual (and, per the design doc, intentional) behavior: the update is
      // conflict-blocked, so the payment-affected ledger is never silently overwritten — which is
      // the invariant the plan actually cared about, just reached via the conflict path instead
      // of a clean metadata apply.
      const { client: readClient, setNext } = stagedReadClient();
      setNext('Invoice', {
        Id: qboId,
        SyncToken: '1',
        DocNumber: 'PP-1-RENAMED',
        DueDate: '2026-08-15',
      });
      const app3 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: readClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const webhookRes = await postWebhook(app3, REALM, [
        { name: 'Invoice', id: qboId, operation: 'Update', lastUpdated: '2026-07-06T00:00:00Z' },
      ]);
      expect(webhookRes.statusCode).toBe(200);

      const [afterInboundUpdate] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceId));
      // Nothing applied — the payment-affected ledger is protected, not silently overwritten.
      expect(afterInboundUpdate?.docNumber).toBe('PP-1');
      expect(afterInboundUpdate?.dueDate).toBeNull();
      expect(afterInboundUpdate?.status).toBe('partially_paid');
      expect(afterInboundUpdate?.balance).toBe('60.00');

      const conflictLink = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      expect(conflictLink?.state).toBe('conflict');
      expect(conflictLink?.conflictDetectedAt).not.toBeNull();

      const conflictAudit = await testDb.db
        .select()
        .from(syncAuditLogs)
        .where(
          and(eq(syncAuditLogs.orgId, orgId), eq(syncAuditLogs.action, 'qbo.inbound.conflict')),
        );
      expect(conflictAudit).toHaveLength(1);
      expect(conflictAudit[0]).toMatchObject({ outcome: 'skipped', direction: 'inbound' });
      expect((conflictAudit[0]?.detail as { reason?: string })?.reason).toBe('both_sides_changed');

      await app3.close();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Timeout after a write to QBO (partial success)
  // -------------------------------------------------------------------------
  describe('6. timeout after a write to QBO', () => {
    it('a create that landed at QBO but whose link write was lost leaves a failed, qboId-null link while the QBO entity already exists', async () => {
      testDb = await createTestDb();
      const { orgId, userId } = await seedOrgWithChart(testDb.db);
      await seedQboConnection(testDb.db, orgId, 'realm-timeout');
      const [contact] = await testDb.db
        .insert(contacts)
        .values({ orgId, displayName: 'Acme Co', isCustomer: true })
        .returning();
      if (!contact) throw new Error('setup: contact insert returned no row');
      const invoice = await createInvoice(
        testDb.db,
        { orgId, userId },
        {
          contactId: contact.id,
          txnDate: '2026-07-01',
          docNumber: 'TIMEOUT-1',
          lines: [{ quantity: 1, unitPrice: '200.00' }],
        },
      );

      const client = createFakeQboWriteClient();
      // Simulate "the create actually landed at QBO" directly against the fake's store — standing
      // in for a prior attempt whose HTTP response (or the local link write that should have
      // followed it) was lost to a timeout.
      await client.createEntity({
        realmId: 'realm-timeout',
        accessToken: 'access-1',
        entityType: 'Invoice',
        body: {
          DocNumber: 'TIMEOUT-1',
          TxnDate: '2026-07-01',
          CustomerRef: { value: 'some-customer-id' },
          Line: [{ Amount: 200, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: {} }],
        },
      });
      expect(client.countOf('create', 'Invoice')).toBe(1);

      // ...but locally we only ever recorded a `failed` link (qboId null) — the link write never
      // happened.
      await markFailed(
        testDb.db,
        orgId,
        'transaction',
        invoice.id,
        'Invoice',
        'simulated: timeout after write, link write lost',
      );

      const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoice.id);
      expect(link?.state).toBe('failed');
      expect(link?.qboId).toBeNull();
      expect(link?.nextRetryAt).not.toBeNull();

      // The entity really is already sitting in QBO — a naive blind retry would double-create it.
      const existing = await client.getEntity({
        realmId: 'realm-timeout',
        accessToken: 'access-1',
        entityType: 'Invoice',
        qboId: '1',
      });
      expect((existing.Invoice as { DocNumber?: string }).DocNumber).toBe('TIMEOUT-1');
    });
  });

  // -------------------------------------------------------------------------
  // 7. Retry after partial success
  // -------------------------------------------------------------------------
  describe('7. retry after partial success', () => {
    it('the retry sweep reconciles via a natural-key query and links the existing entity — no second create', async () => {
      testDb = await createTestDb();
      const { orgId, userId } = await seedOrgWithChart(testDb.db);
      await seedQboConnection(testDb.db, orgId, 'realm-reconcile');
      const [contact] = await testDb.db
        .insert(contacts)
        .values({ orgId, displayName: 'Acme Co', isCustomer: true })
        .returning();
      if (!contact) throw new Error('setup: contact insert returned no row');
      const invoice = await createInvoice(
        testDb.db,
        { orgId, userId },
        {
          contactId: contact.id,
          txnDate: '2026-07-01',
          docNumber: 'RECONCILE-1',
          lines: [{ quantity: 1, unitPrice: '150.00' }],
        },
      );

      const client = createFakeQboWriteClient();
      await client.createEntity({
        realmId: 'realm-reconcile',
        accessToken: 'access-1',
        entityType: 'Invoice',
        body: {
          DocNumber: 'RECONCILE-1',
          TxnDate: '2026-07-01',
          CustomerRef: { value: 'some-customer-id' },
          Line: [{ Amount: 150, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: {} }],
        },
      });
      await markFailed(
        testDb.db,
        orgId,
        'transaction',
        invoice.id,
        'Invoice',
        'simulated: timeout after write, link write lost',
      );
      const failedLink = await findLinkByLocal(testDb.db, orgId, 'transaction', invoice.id);
      if (!failedLink?.nextRetryAt) throw new Error('setup: expected a due nextRetryAt');

      const summary = await runOutboundRetrySweep(
        testDb.db,
        { oauthClient: fakeOAuthClient(), apiClient: client },
        new Date(failedLink.nextRetryAt.getTime() + 1),
      );

      expect(summary).toEqual({ retried: 1, succeeded: 1, failed: 0, terminal: 0, cleared: 0 });
      expect(client.countOf('query', 'Invoice')).toBeGreaterThanOrEqual(1); // queried by natural key
      expect(client.countOf('create', 'Invoice')).toBe(1); // still just the ORIGINAL create

      const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoice.id);
      expect(link?.state).toBe('synced');
      expect(link?.qboId).toBe('1'); // linked to the fake's first (and only) assigned id
      expect(link?.retryCount).toBe(0);
      expect(link?.nextRetryAt).toBeNull();
      expect(link?.lastError).toBeNull();
    });

    it('a plain transient create failure recovers on the next sweep tick with exactly one successful create', async () => {
      testDb = await createTestDb();
      const { orgId, userId } = await seedOrgWithChart(testDb.db);
      await seedQboConnection(testDb.db, orgId, 'realm-plain-retry');
      const [contact] = await testDb.db
        .insert(contacts)
        .values({ orgId, displayName: 'Acme Co', isCustomer: true })
        .returning();
      if (!contact) throw new Error('setup: contact insert returned no row');
      const invoice = await createInvoice(
        testDb.db,
        { orgId, userId },
        {
          contactId: contact.id,
          txnDate: '2026-07-01',
          docNumber: 'RETRY-PLAIN-1',
          lines: [{ quantity: 1, unitPrice: '75.00' }],
        },
      );

      await markFailed(
        testDb.db,
        orgId,
        'transaction',
        invoice.id,
        'Invoice',
        'simulated first failure',
      );
      let link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoice.id);
      if (!link?.nextRetryAt) throw new Error('setup: expected a due nextRetryAt');

      // Outage still ongoing on this tick — the invoice's own create still fails. Scoped to
      // `entityType === 'Invoice'` only: the sweep also has to ensure the contact/account refs are
      // synced first (`ensureEntitySynced`), and a blanket `method==='create'` failOn would fail
      // those ref pushes too, never even reaching the invoice's own create call.
      const failingClient = createFakeQboWriteClient({
        failOn: (call) =>
          call.method === 'create' && call.entityType === 'Invoice'
            ? new Error('transient outage')
            : undefined,
      });
      const failedSweep = await runOutboundRetrySweep(
        testDb.db,
        { oauthClient: fakeOAuthClient(), apiClient: failingClient },
        new Date(link.nextRetryAt.getTime() + 1),
      );
      expect(failedSweep).toEqual({ retried: 1, succeeded: 0, failed: 1, terminal: 0, cleared: 0 });
      expect(failingClient.countOf('create', 'Invoice')).toBe(1);
      link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoice.id);
      expect(link?.state).toBe('failed');
      if (!link?.nextRetryAt)
        throw new Error('expected another due nextRetryAt after the 2nd failure');

      // Outage clears — a fresh client (standing in for QBO being reachable again) succeeds.
      const workingClient = createFakeQboWriteClient();
      const summary = await runOutboundRetrySweep(
        testDb.db,
        { oauthClient: fakeOAuthClient(), apiClient: workingClient },
        new Date(link.nextRetryAt.getTime() + 1),
      );
      expect(summary).toEqual({ retried: 1, succeeded: 1, failed: 0, terminal: 0, cleared: 0 });
      expect(workingClient.countOf('create', 'Invoice')).toBe(1); // exactly one successful create
      link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoice.id);
      expect(link?.state).toBe('synced');
    });
  });

  // -------------------------------------------------------------------------
  // 8. Pre-existing invoices in both systems, no linkage
  // -------------------------------------------------------------------------
  describe('8. pre-existing invoices in both systems, no linkage', () => {
    it('a confident natural-key match links the existing local invoice instead of creating a duplicate', async () => {
      testDb = await createTestDb();
      const REALM = 'realm-prelink';
      const { orgId, password } = await seedOrgAndAdmin(testDb.db);
      await seedQboConnection(testDb.db, orgId, REALM);

      // No QBO client at create time -> the invoice is created with NO sync_links row at all.
      const app1 = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
      const sid = await login(app1, password);
      const contactId = await createCustomer(app1, sid);
      const createRes = await app1.inject({
        method: 'POST',
        url: '/api/invoices',
        cookies: { __session: sid },
        payload: {
          contactId,
          txnDate: '2026-03-01',
          docNumber: 'PRE-A',
          lines: [{ quantity: 1, unitPrice: 150 }],
        },
      });
      const invoiceId = (createRes.json() as { id: string }).id;
      expect(await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId)).toBeNull();
      await app1.close();

      const { client: readClient, setNext } = stagedReadClient();
      setNext('Invoice', {
        Id: 'qbo-pre-1',
        SyncToken: '0',
        DocNumber: 'PRE-A',
        TotalAmt: 150,
        TxnDate: '2026-03-01',
      });
      const app2 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: readClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const webhookRes = await postWebhook(app2, REALM, [
        {
          name: 'Invoice',
          id: 'qbo-pre-1',
          operation: 'Update',
          lastUpdated: '2026-03-02T00:00:00Z',
        },
      ]);
      expect(webhookRes.statusCode).toBe(200);

      const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      expect(link?.state).toBe('synced');
      expect(link?.qboId).toBe('qbo-pre-1');

      const listRes = await app2.inject({
        method: 'GET',
        url: '/api/invoices',
        cookies: { __session: sid },
      });
      // No duplicate local invoice was created for the "same" QBO record.
      expect((listRes.json() as unknown[]).length).toBe(1);

      const linkAudit = await testDb.db
        .select()
        .from(syncAuditLogs)
        .where(and(eq(syncAuditLogs.orgId, orgId), eq(syncAuditLogs.action, 'qbo.inbound.link')));
      expect(linkAudit).toHaveLength(1);
      expect((linkAudit[0]?.detail as { matchedBy?: string })?.matchedBy).toBe('natural_key');

      await app2.close();
    });

    it('an ambiguous natural-key match (two identical local candidates) is skipped — no link, no mutation', async () => {
      testDb = await createTestDb();
      const REALM = 'realm-ambiguous';
      const { orgId, password } = await seedOrgAndAdmin(testDb.db);
      await seedQboConnection(testDb.db, orgId, REALM);

      const app1 = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
      const sid = await login(app1, password);
      const contactId = await createCustomer(app1, sid);
      const dup1Res = await app1.inject({
        method: 'POST',
        url: '/api/invoices',
        cookies: { __session: sid },
        payload: {
          contactId,
          txnDate: '2026-03-05',
          docNumber: 'PRE-DUP',
          lines: [{ quantity: 1, unitPrice: 75 }],
        },
      });
      const dup2Res = await app1.inject({
        method: 'POST',
        url: '/api/invoices',
        cookies: { __session: sid },
        payload: {
          contactId,
          txnDate: '2026-03-05',
          docNumber: 'PRE-DUP',
          lines: [{ quantity: 1, unitPrice: 75 }],
        },
      });
      const invoiceId1 = (dup1Res.json() as { id: string }).id;
      const invoiceId2 = (dup2Res.json() as { id: string }).id;
      await app1.close();

      const { client: readClient, setNext } = stagedReadClient();
      setNext('Invoice', {
        Id: 'qbo-dup-1',
        SyncToken: '0',
        DocNumber: 'PRE-DUP',
        TotalAmt: 75,
        TxnDate: '2026-03-05',
      });
      const app2 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: readClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const webhookRes = await postWebhook(app2, REALM, [
        {
          name: 'Invoice',
          id: 'qbo-dup-1',
          operation: 'Update',
          lastUpdated: '2026-03-06T00:00:00Z',
        },
      ]);
      expect(webhookRes.statusCode).toBe(200);

      expect(await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId1)).toBeNull();
      expect(await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId2)).toBeNull();

      const skipAudit = await testDb.db
        .select()
        .from(syncAuditLogs)
        .where(and(eq(syncAuditLogs.orgId, orgId), eq(syncAuditLogs.action, 'qbo.inbound.skip')));
      const ambiguous = skipAudit.find(
        (r) => (r.detail as { reason?: string })?.reason === 'ambiguous_natural_key_match',
      );
      expect(ambiguous).toBeDefined();
      expect((ambiguous?.detail as { candidateCount?: number })?.candidateCount).toBe(2);

      const listRes = await app2.inject({
        method: 'GET',
        url: '/api/invoices',
        cookies: { __session: sid },
      });
      expect((listRes.json() as unknown[]).length).toBe(2); // no third invoice created

      await app2.close();
    });
  });

  // -------------------------------------------------------------------------
  // 9. Invoice created only in QBO (inbound create + auto-link by QBO id) — 30016
  // -------------------------------------------------------------------------
  describe('9. invoice created only in QBO (inbound import)', () => {
    it('a QBO-only invoice webhook creates + links a local invoice with a balanced ledger; redelivery + a later edit never duplicate it', async () => {
      testDb = await createTestDb();
      const REALM = 'realm-inbound-create';
      const { orgId } = await seedOrgAndAdmin(testDb.db);
      await seedQboConnection(testDb.db, orgId, REALM);

      const { client: readClient, setNext } = stagedReadClient();
      const app = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: readClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });

      // A QBO invoice that has no local counterpart and no natural-key match.
      const qboInvoiceId = 'qbo-only-147';
      setNext('Invoice', {
        Id: qboInvoiceId,
        SyncToken: '0',
        DocNumber: 'QBO-147',
        TxnDate: '2026-05-01',
        TotalAmt: 300,
        CustomerRef: { value: 'qbo-cust-147', name: 'Beta LLC' },
        Line: [
          {
            Amount: 300,
            DetailType: 'SalesItemLineDetail',
            Description: 'Consulting',
            SalesItemLineDetail: { Qty: 3, UnitPrice: 100 },
          },
        ],
      });

      const createEvent = {
        name: 'Invoice',
        id: qboInvoiceId,
        operation: 'Create',
        lastUpdated: '2026-05-02T00:00:00Z',
      };
      const firstRes = await postWebhook(app, REALM, [createEvent]);
      expect(firstRes.statusCode).toBe(200);

      // Exactly one local invoice now exists, linked to the QBO id.
      const invoices = await testDb.db
        .select()
        .from(transactions)
        .where(and(eq(transactions.orgId, orgId), eq(transactions.type, 'customer_invoice')));
      expect(invoices).toHaveLength(1);
      const invoice = invoices[0];
      if (!invoice) throw new Error('expected the imported invoice');
      expect(invoice.docNumber).toBe('QBO-147');
      expect(invoice.total).toBe('300.00');
      expect(invoice.status).toBe('open');

      const link = await findLinkByLocal(testDb.db, orgId, 'transaction', invoice.id);
      expect(link?.qboId).toBe(qboInvoiceId);
      expect(link?.state).toBe('synced');

      // Contact resolved from CustomerRef: created + linked to the QBO customer id.
      const contactLink = await findLinkByQbo(testDb.db, orgId, 'Customer', 'qbo-cust-147');
      expect(contactLink?.state).toBe('synced');
      expect(invoice.contactId).toBe(contactLink?.localId);
      const [contact] = await testDb.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, contactLink?.localId ?? ''));
      expect(contact?.displayName).toBe('Beta LLC');

      // Ledger is balanced: debit A/R 300 / credit income 300 (total debits == total credits).
      const ledgerRows = await testDb.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.transactionId, invoice.id));
      const totalDebit = ledgerRows.reduce((sum, r) => sum + Number(r.debit), 0);
      const totalCredit = ledgerRows.reduce((sum, r) => sum + Number(r.credit), 0);
      expect(totalDebit).toBe(300);
      expect(totalCredit).toBe(300);

      const createAudit = await testDb.db
        .select()
        .from(syncAuditLogs)
        .where(and(eq(syncAuditLogs.orgId, orgId), eq(syncAuditLogs.action, 'qbo.inbound.create')));
      expect(createAudit).toHaveLength(1);
      expect(createAudit[0]).toMatchObject({ outcome: 'success', localId: invoice.id });

      // (b) Byte-identical redelivery -> deduped by event-dedup, no second invoice.
      const dupRes = await postWebhook(app, REALM, [createEvent]);
      expect(dupRes.statusCode).toBe(200);
      const afterDup = await testDb.db
        .select()
        .from(transactions)
        .where(and(eq(transactions.orgId, orgId), eq(transactions.type, 'customer_invoice')));
      expect(afterDup).toHaveLength(1); // still exactly one
      const duplicates = await testDb.db
        .select()
        .from(syncAuditLogs)
        .where(
          and(eq(syncAuditLogs.orgId, orgId), eq(syncAuditLogs.action, 'qbo.webhook.duplicate')),
        );
      expect(duplicates).toHaveLength(1);

      // (c) A later, genuinely-newer edit for the SAME QBO id takes the linked-update path
      // (not a second create) — the sync_links row created above makes it idempotent.
      setNext('Invoice', {
        Id: qboInvoiceId,
        SyncToken: '1',
        DocNumber: 'QBO-147',
        TxnDate: '2026-05-01',
        TotalAmt: 300,
        PrivateNote: 'edited in quickbooks',
        CustomerRef: { value: 'qbo-cust-147', name: 'Beta LLC' },
      });
      const editRes = await postWebhook(app, REALM, [
        {
          name: 'Invoice',
          id: qboInvoiceId,
          operation: 'Update',
          lastUpdated: '2026-05-03T00:00:00Z',
        },
      ]);
      expect(editRes.statusCode).toBe(200);
      const afterEdit = await testDb.db
        .select()
        .from(transactions)
        .where(and(eq(transactions.orgId, orgId), eq(transactions.type, 'customer_invoice')));
      expect(afterEdit).toHaveLength(1); // never a duplicate
      expect(afterEdit[0]?.memo).toBe('edited in quickbooks');

      await app.close();
    });
  });

  // -------------------------------------------------------------------------
  // Coverage-gap sweep: an interplay the per-scenario tests above don't individually cover —
  // a stale (out-of-order) event that is ALSO redelivered must be deduped on the second delivery,
  // not silently re-evaluated for staleness (and definitely not re-applied) every time.
  // -------------------------------------------------------------------------
  describe('coverage-gap interplay: duplicate delivery of a stale (out-of-order) event', () => {
    it('a stale event, once skipped, is deduped on identical redelivery rather than re-evaluated', async () => {
      testDb = await createTestDb();
      const REALM = 'realm-stale-dup';
      const { orgId, password } = await seedOrgAndAdmin(testDb.db);
      await seedQboConnection(testDb.db, orgId, REALM);

      const writeClient = createFakeQboWriteClient();
      const app1 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: writeClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });
      const sid = await login(app1, password);
      const contactId = await createCustomer(app1, sid);
      const createRes = await app1.inject({
        method: 'POST',
        url: '/api/invoices',
        cookies: { __session: sid },
        payload: {
          contactId,
          txnDate: '2026-07-01',
          docNumber: 'STALE-DUP-1',
          lines: [{ quantity: 1, unitPrice: 100 }],
        },
      });
      const invoiceId = (createRes.json() as { id: string }).id;
      const link0 = await findLinkByLocal(testDb.db, orgId, 'transaction', invoiceId);
      if (!link0?.qboId) throw new Error('setup: expected the invoice to be linked after create');
      const qboId = link0.qboId; // stored SyncToken '0' after create
      await app1.close();

      const { client: readClient, setNext } = stagedReadClient();
      setNext('Invoice', { Id: qboId, SyncToken: '0', PrivateNote: 'stale-note' }); // equal -> stale
      const app2 = buildApp({
        db: testDb.db,
        qboOAuthClient: fakeOAuthClient(),
        qboApiClient: readClient,
        qboWebhookVerifierToken: VERIFIER_TOKEN,
      });

      const entity = {
        name: 'Invoice',
        id: qboId,
        operation: 'Update',
        lastUpdated: '2026-07-02T00:00:00Z',
      };
      const firstRes = await postWebhook(app2, REALM, [entity]);
      expect(firstRes.statusCode).toBe(200);

      const [afterFirst] = await testDb.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, invoiceId));
      expect(afterFirst?.memo).not.toBe('stale-note'); // never applied — it was stale

      // Redeliver the IDENTICAL stale event (same realm/entity/operation/lastUpdated).
      const secondRes = await postWebhook(app2, REALM, [entity]);
      expect(secondRes.statusCode).toBe(200);

      // NB: `qbo.webhook.duplicate` is written by the webhook route BEFORE any local match is
      // attempted (`routes/qbo-webhook.ts`), so it always carries `localId: null` — query by
      // `orgId` only, not `localId`, or the duplicate row would be invisible to this filter.
      const auditRows = await testDb.db
        .select()
        .from(syncAuditLogs)
        .where(eq(syncAuditLogs.orgId, orgId));
      const staleSkips = auditRows.filter(
        (r) =>
          r.action === 'qbo.inbound.skip' &&
          (r.detail as { reason?: string })?.reason === 'stale_ignored',
      );
      const duplicates = auditRows.filter((r) => r.action === 'qbo.webhook.duplicate');
      // Anti-tautology: if dedup didn't cover the already-skipped event, this would be 2 stale
      // skips and 0 duplicates instead.
      expect(staleSkips).toHaveLength(1);
      expect(duplicates).toHaveLength(1);

      await app2.close();
    });
  });
});
