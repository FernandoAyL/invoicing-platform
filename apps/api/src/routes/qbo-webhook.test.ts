import { createHmac, randomUUID } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import * as schema from '../db/schema.ts';

const VERIFIER_TOKEN = 'test-verifier';
const ORG_A = 'org-a';
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

interface FakeUserRow {
  id: string;
  orgId: string;
  email: string;
  passwordHash: string;
  role: 'admin' | 'member';
}

function fakePool(): pg.Pool {
  return {
    query: async () => ({ rows: [] }),
    end: async () => {},
  } as unknown as pg.Pool;
}

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
const userColumnKeyByRef = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.users)).map(([key, col]) => [col, key]),
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
    users: [] as FakeUserRow[],
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
          if (table === schema.users) {
            return {
              where(cond: unknown) {
                return {
                  async limit() {
                    return state.users.filter((r) =>
                      rowMatchesWith(
                        r as unknown as Record<string, unknown>,
                        cond,
                        userColumnKeyByRef,
                      ),
                    );
                  },
                };
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
          if (table === schema.sessions) {
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
            {
              name: 'Invoice',
              id: 'qbo-inv-1',
              operation: 'Update',
              lastUpdated: '2026-07-05T00:00:00Z',
            },
          ],
        },
      },
    ],
  };
}

async function seedConnection(state: ReturnType<typeof createFakeDb>['state']) {
  const now = new Date();
  state.connections.push({
    id: randomUUID(),
    orgId: ORG_A,
    realmId: REALM_A,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: now,
    refreshTokenExpiresAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

describe('POST /api/integrations/qbo/webhook', () => {
  it('returns 200 and records one audit row per entity for a valid signature + known realm', async () => {
    const { db, state } = createFakeDb();
    await seedConnection(state);
    const app = buildApp({ pool: fakePool(), db, qboWebhookVerifierToken: VERIFIER_TOKEN });

    const body = JSON.stringify(validPayload());
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(state.auditLogs).toHaveLength(1);
    expect(state.auditLogs[0]).toMatchObject({
      orgId: ORG_A,
      entityType: 'Invoice',
      localId: 'qbo-inv-1',
      action: 'qbo.webhook.received',
      direction: 'inbound',
      outcome: 'success',
      triggeringEvent: `${REALM_A}:Invoice:qbo-inv-1:Update`,
    });
    await app.close();
  });

  it('returns 401 and writes zero audit rows for a bad signature', async () => {
    const { db, state } = createFakeDb();
    await seedConnection(state);
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

  it('returns 200 with zero audit rows and does not throw for an unknown realmId', async () => {
    const { db, state } = createFakeDb();
    // no connection seeded — realm resolves to nothing
    const app = buildApp({ pool: fakePool(), db, qboWebhookVerifierToken: VERIFIER_TOKEN });

    const body = JSON.stringify(validPayload({ realmId: 'realm-unknown' }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/webhook',
      headers: { 'content-type': 'application/json', 'intuit-signature': sign(body) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(state.auditLogs).toHaveLength(0);
    await app.close();
  });

  it('returns 400 for a malformed shape (missing eventNotifications)', async () => {
    const { db, state } = createFakeDb();
    await seedConnection(state);
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
    await seedConnection(state);
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
    await seedConnection(state);
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

  it('handles multiple notifications and multiple entities — one audit row per entity', async () => {
    const { db, state } = createFakeDb();
    await seedConnection(state);
    const now = new Date();
    state.connections.push({
      id: randomUUID(),
      orgId: 'org-b',
      realmId: 'realm-b',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: now,
      refreshTokenExpiresAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const app = buildApp({ pool: fakePool(), db, qboWebhookVerifierToken: VERIFIER_TOKEN });

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
    expect(state.auditLogs).toHaveLength(3);
    expect(state.auditLogs.filter((a) => a.orgId === ORG_A)).toHaveLength(2);
    expect(state.auditLogs.filter((a) => a.orgId === 'org-b')).toHaveLength(1);
    await app.close();
  });

  it('returns 200 with zero audit rows for an empty eventNotifications array', async () => {
    const { db, state } = createFakeDb();
    await seedConnection(state);
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

  it('regression: an unrelated JSON route (POST /api/auth/login) still parses its body normally', async () => {
    const { db, state } = createFakeDb();
    const password = 'correct horse battery staple';
    state.users.push({
      id: 'user-1',
      orgId: ORG_A,
      email: 'admin@invoicing.test',
      passwordHash: await hashPassword(password),
      role: 'admin',
    });
    const app = buildApp({ pool: fakePool(), db, qboWebhookVerifierToken: VERIFIER_TOKEN });

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
