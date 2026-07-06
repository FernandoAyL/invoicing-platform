import { createHmac, randomUUID } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import { buildApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import * as schema from '../db/schema.ts';

const VERIFIER_TOKEN = 'test-verifier';
const REALM_A = 'realm-a';

interface FakeConnectionRow {
  id: string;
  orgId: string;
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeAuditRow {
  id: string;
  orgId: string;
  entityType: string | null;
  localId: string | null;
  action: string;
  direction: string;
  outcome: string;
  triggeringEvent: string | null;
  detail: unknown;
  userId: string | null;
  createdAt: Date;
}

function fakePool(): pg.Pool {
  return {
    query: async () => ({ rows: [] }),
    end: async () => {},
  } as unknown as pg.Pool;
}

// --- Fake-db helpers, kept for the routes below that never write to the DB (schema/config/
// auth failures short-circuit before any insert), so they don't pay for a pglite boot. The
// DB-touching cases (success path, unknown realm, multi-entity, and the login regression) are
// ported to `createTestDb()` below — see the `20015` harness: the fake db's `insert().values()`
// pushed straight into a JS array with no type/constraint enforcement, which is exactly what let
// the `local_id` uuid-column bug (20002) slip past this whole suite.

interface SqlChunk {
  queryChunks?: SqlChunk[];
  constructor: { name: string };
  value?: unknown;
  table?: unknown;
  name?: unknown;
}

function extractEqPairs(
  node: SqlChunk | null | undefined,
  acc: { columns: SqlChunk[]; params: unknown[] } = { columns: [], params: [] },
) {
  if (!node) return acc;
  if (Array.isArray(node.queryChunks)) {
    for (const chunk of node.queryChunks) extractEqPairs(chunk, acc);
    return acc;
  }
  const ctorName = node.constructor?.name;
  if (ctorName === 'Param') {
    acc.params.push(node.value);
  } else if (ctorName !== 'StringChunk' && node.table && typeof node.name === 'string') {
    acc.columns.push(node);
  }
  return acc;
}

const connectionColumnKeyByRef = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.qboConnections)).map(([key, col]) => [col, key]),
);

function rowMatchesWith(
  row: Record<string, unknown>,
  cond: unknown,
  columnMap: Map<unknown, string>,
): boolean {
  const { columns, params } = extractEqPairs(cond as SqlChunk);
  if (columns.length === 0) return true;
  return columns.every((col, i) => {
    const key = columnMap.get(col);
    if (!key) throw new Error('fakeDb: unmapped column in where clause');
    return row[key] === params[i];
  });
}

function cloneRow<T>(row: T): T {
  return { ...row };
}

function createFakeDb() {
  const state = {
    connections: [] as FakeConnectionRow[],
    auditLogs: [] as FakeAuditRow[],
  };

  const db = {
    select() {
      return {
        from(table: unknown) {
          if (table === schema.qboConnections) {
            return {
              where(cond: unknown) {
                const filtered = state.connections.filter((r) =>
                  rowMatchesWith(
                    r as unknown as Record<string, unknown>,
                    cond,
                    connectionColumnKeyByRef,
                  ),
                );
                const result = Promise.resolve(filtered.map(cloneRow)) as Promise<
                  FakeConnectionRow[]
                > & { limit: (n: number) => Promise<FakeConnectionRow[]> };
                result.limit = (n: number) => Promise.resolve(filtered.slice(0, n).map(cloneRow));
                return result;
              },
            };
          }
          throw new Error('fakeDb: unsupported select().from() table');
        },
      };
    },
    insert(table: unknown) {
      return {
        values(vals: Record<string, unknown>) {
          if (table === schema.syncAuditLogs) {
            const row: FakeAuditRow = {
              id: randomUUID(),
              orgId: vals.orgId as string,
              entityType: (vals.entityType as string | undefined) ?? null,
              localId: (vals.localId as string | undefined) ?? null,
              action: vals.action as string,
              direction: vals.direction as string,
              outcome: (vals.outcome as string | undefined) ?? 'success',
              triggeringEvent: (vals.triggeringEvent as string | undefined) ?? null,
              detail: vals.detail ?? null,
              userId: (vals.userId as string | undefined) ?? null,
              createdAt: new Date(),
            };
            state.auditLogs.push(row);
            return Promise.resolve(undefined);
          }
          throw new Error('fakeDb: unsupported insert().values() table');
        },
      };
    },
  };

  return { db: db as unknown as NodePgDatabase<typeof schema>, state };
}

function sign(body: string, token = VERIFIER_TOKEN): string {
  return createHmac('sha256', token).update(body, 'utf8').digest('base64');
}

function validPayload(overrides: { realmId?: string } = {}) {
  return {
    eventNotifications: [
      {
        realmId: overrides.realmId ?? REALM_A,
        dataChangeEvent: {
          entities: [
            // QBO entity ids are plain numeric strings, not uuids — matches Intuit's real
            // payload shape and exercises that `local_id` (a uuid column) never receives this.
            {
              name: 'Invoice',
              id: '145',
              operation: 'Update',
              lastUpdated: '2026-07-05T00:00:00Z',
            },
          ],
        },
      },
    ],
  };
}

async function seedFakeConnection(state: ReturnType<typeof createFakeDb>['state']) {
  const now = new Date();
  state.connections.push({
    id: randomUUID(),
    orgId: 'org-a',
    realmId: REALM_A,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: now,
    refreshTokenExpiresAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

describe('POST /api/integrations/qbo/webhook (fake db — no DB write on these paths)', () => {
  it('returns 401 and writes zero audit rows for a bad signature', async () => {
    const { db, state } = createFakeDb();
    await seedFakeConnection(state);
    const app = buildApp({ pool: fakePool(), db, qboWebhookVerifierToken: VERIFIER_TOKEN });

    const body = JSON.stringify(validPayload());
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: {
        'content-type': 'application/json',
        'intuit-signature': sign(body, 'wrong-token'),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_signature' });
    expect(state.auditLogs).toHaveLength(0);
    await app.close();
  });

  it('returns 400 for a malformed shape (missing eventNotifications)', async () => {
    const { db, state } = createFakeDb();
    await seedFakeConnection(state);
    const app = buildApp({ pool: fakePool(), db, qboWebhookVerifierToken: VERIFIER_TOKEN });

    const body = JSON.stringify({ notEventNotifications: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(state.auditLogs).toHaveLength(0);
    await app.close();
  });

  it('returns 400 for invalid JSON, signed over that same raw (invalid) string', async () => {
    const { db, state } = createFakeDb();
    await seedFakeConnection(state);
    const app = buildApp({ pool: fakePool(), db, qboWebhookVerifierToken: VERIFIER_TOKEN });

    const body = '{ not valid json';
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_json' });
    await app.close();
  });

  it('returns 503 qbo_webhook_not_configured with no token injected and config.qbo null', async () => {
    const { db, state } = createFakeDb();
    await seedFakeConnection(state);
    const app = buildApp({ pool: fakePool(), db, qboWebhookVerifierToken: null });

    const body = JSON.stringify(validPayload());
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
      payload: body,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'qbo_webhook_not_configured' });
    expect(state.auditLogs).toHaveLength(0);
    await app.close();
  });

  it('returns 200 with zero audit rows for an empty eventNotifications array', async () => {
    const { db, state } = createFakeDb();
    await seedFakeConnection(state);
    const app = buildApp({ pool: fakePool(), db, qboWebhookVerifierToken: VERIFIER_TOKEN });

    const body = JSON.stringify({ eventNotifications: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(state.auditLogs).toHaveLength(0);
    await app.close();
  });
});

describe('POST /api/integrations/qbo/webhook (real Postgres via pglite)', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  async function seedConnection(realmId: string) {
    const { orgId } = await seedBaseOrg(testDb.db);
    const now = new Date();
    await testDb.db.insert(schema.qboConnections).values({
      orgId,
      realmId,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: now,
      refreshTokenExpiresAt: now,
    });
    return orgId;
  }

  it('returns 200 and records one audit row per entity for a valid signature + known realm', async () => {
    const orgId = await seedConnection(REALM_A);
    const app = buildApp({
      pool: fakePool(),
      db: testDb.db,
      qboWebhookVerifierToken: VERIFIER_TOKEN,
    });

    const body = JSON.stringify(validPayload());
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const auditRows = await testDb.db.select().from(schema.syncAuditLogs);
    expect(auditRows).toHaveLength(1);
    // `local_id` is a uuid column — a QBO-originated event has no local row yet (mapping/apply
    // are later tasks), so it must be null, never the QBO entity id (a non-uuid numeric string).
    // The QBO id is preserved in triggeringEvent/detail instead. On the old fake db this
    // assertion passed even when `localId` held a non-uuid string; on real Postgres, a wrong
    // value here would have thrown at insert time instead (see test-db.test.ts).
    expect(auditRows[0]?.localId).toBeNull();
    expect(auditRows[0]).toMatchObject({
      orgId,
      entityType: 'Invoice',
      localId: null,
      action: 'qbo.webhook.received',
      direction: 'inbound',
      outcome: 'success',
      triggeringEvent: `${REALM_A}:Invoice:145:Update`,
      detail: { name: 'Invoice', id: '145', operation: 'Update' },
    });
    await app.close();
  });

  it('returns 200 with zero audit rows and does not throw for an unknown realmId', async () => {
    // no connection seeded — realm resolves to nothing
    const app = buildApp({
      pool: fakePool(),
      db: testDb.db,
      qboWebhookVerifierToken: VERIFIER_TOKEN,
    });

    const body = JSON.stringify(validPayload({ realmId: 'realm-unknown' }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const auditRows = await testDb.db.select().from(schema.syncAuditLogs);
    expect(auditRows).toHaveLength(0);
    await app.close();
  });

  it('handles multiple notifications and multiple entities — one audit row per entity, across orgs', async () => {
    const orgAId = await seedConnection(REALM_A);
    const now = new Date();
    const { orgId: orgBId } = await seedBaseOrg(testDb.db, { name: 'Org B' });
    await testDb.db.insert(schema.qboConnections).values({
      orgId: orgBId,
      realmId: 'realm-b',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: now,
      refreshTokenExpiresAt: now,
    });
    const app = buildApp({
      pool: fakePool(),
      db: testDb.db,
      qboWebhookVerifierToken: VERIFIER_TOKEN,
    });

    const payload = {
      eventNotifications: [
        {
          realmId: REALM_A,
          dataChangeEvent: {
            entities: [
              { name: 'Invoice', id: 'inv-1', operation: 'Create' },
              { name: 'Customer', id: 'cust-1', operation: 'Update' },
            ],
          },
        },
        {
          realmId: 'realm-b',
          dataChangeEvent: {
            entities: [{ name: 'Payment', id: 'pay-1', operation: 'Create' }],
          },
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const auditRows = await testDb.db.select().from(schema.syncAuditLogs);
    expect(auditRows).toHaveLength(3);
    expect(auditRows.filter((a) => a.orgId === orgAId)).toHaveLength(2);
    expect(auditRows.filter((a) => a.orgId === orgBId)).toHaveLength(1);
    expect(auditRows.every((a) => a.localId === null)).toBe(true);
    await app.close();
  });

  it('dedups a redelivered webhook: identical body posted twice yields exactly one received row', async () => {
    const orgId = await seedConnection(REALM_A);
    const app = buildApp({
      pool: fakePool(),
      db: testDb.db,
      qboWebhookVerifierToken: VERIFIER_TOKEN,
    });

    const body = JSON.stringify(validPayload());

    const firstRes = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
      payload: body,
    });
    const secondRes = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
      payload: body,
    });

    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.json()).toEqual({ ok: true });

    const auditRows = await testDb.db.select().from(schema.syncAuditLogs);
    const received = auditRows.filter((r) => r.action === 'qbo.webhook.received');
    const duplicates = auditRows.filter((r) => r.action === 'qbo.webhook.duplicate');
    // Anti-tautology: removing the dedup check would make this 2, not 1.
    expect(received).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ orgId, outcome: 'skipped', direction: 'inbound' });

    const eventRows = await testDb.db.select().from(schema.processedEvents);
    expect(eventRows).toHaveLength(1);

    await app.close();
  });

  it('does not dedup a genuine second edit of the same entity (new lastUpdated)', async () => {
    await seedConnection(REALM_A);
    const app = buildApp({
      pool: fakePool(),
      db: testDb.db,
      qboWebhookVerifierToken: VERIFIER_TOKEN,
    });

    const firstBody = JSON.stringify(validPayload());
    const secondPayload = {
      eventNotifications: [
        {
          realmId: REALM_A,
          dataChangeEvent: {
            entities: [
              {
                name: 'Invoice',
                id: '145',
                operation: 'Update',
                lastUpdated: '2026-07-06T00:00:00Z',
              },
            ],
          },
        },
      ],
    };
    const secondBody = JSON.stringify(secondPayload);

    await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(firstBody) },
      payload: firstBody,
    });
    const secondRes = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(secondBody) },
      payload: secondBody,
    });

    expect(secondRes.statusCode).toBe(200);

    const auditRows = await testDb.db.select().from(schema.syncAuditLogs);
    const received = auditRows.filter((r) => r.action === 'qbo.webhook.received');
    expect(received).toHaveLength(2);

    const eventRows = await testDb.db.select().from(schema.processedEvents);
    expect(eventRows).toHaveLength(2);

    await app.close();
  });

  it('per-entity dedup: in a notification with two entities, only the already-processed one is skipped', async () => {
    const orgId = await seedConnection(REALM_A);
    const app = buildApp({
      pool: fakePool(),
      db: testDb.db,
      qboWebhookVerifierToken: VERIFIER_TOKEN,
    });

    const firstBody = JSON.stringify(validPayload());
    await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(firstBody) },
      payload: firstBody,
    });

    const secondPayload = {
      eventNotifications: [
        {
          realmId: REALM_A,
          dataChangeEvent: {
            entities: [
              // Same entity/lastUpdated as validPayload() -> duplicate.
              {
                name: 'Invoice',
                id: '145',
                operation: 'Update',
                lastUpdated: '2026-07-05T00:00:00Z',
              },
              // New entity -> processed normally.
              {
                name: 'Customer',
                id: '9',
                operation: 'Create',
                lastUpdated: '2026-07-05T01:00:00Z',
              },
            ],
          },
        },
      ],
    };
    const secondBody = JSON.stringify(secondPayload);
    const secondRes = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(secondBody) },
      payload: secondBody,
    });

    expect(secondRes.statusCode).toBe(200);

    const auditRows = await testDb.db.select().from(schema.syncAuditLogs);
    const received = auditRows.filter((r) => r.action === 'qbo.webhook.received');
    const duplicates = auditRows.filter((r) => r.action === 'qbo.webhook.duplicate');
    expect(received).toHaveLength(2); // Invoice (first post) + Customer (second post)
    expect(duplicates).toHaveLength(1); // Invoice redelivered in the second post
    expect(received.some((r) => r.entityType === 'Customer' && r.orgId === orgId)).toBe(true);

    await app.close();
  });

  it('regression: an unrelated JSON route (POST /api/auth/login) still parses its body normally', async () => {
    const { orgId } = await seedBaseOrg(testDb.db);
    const password = 'correct horse battery staple';
    await testDb.db.insert(schema.users).values({
      orgId,
      email: 'admin@invoicing.test',
      passwordHash: await hashPassword(password),
      role: 'admin',
    });
    const app = buildApp({
      pool: fakePool(),
      db: testDb.db,
      qboWebhookVerifierToken: VERIFIER_TOKEN,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@invoicing.test', password },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'admin@invoicing.test', role: 'admin' });
    await app.close();
  });
});
