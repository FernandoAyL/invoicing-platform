import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import { buildApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import { syncAuditLogs, users } from '../db/schema.ts';

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
  return { orgId, email: user.email, password };
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

interface SeedRowInput {
  orgId: string;
  action: string;
  direction: 'inbound' | 'outbound' | 'local';
  outcome: 'success' | 'failure' | 'skipped';
  createdAt: Date;
}

async function seedActivityRow(db: TestDb['db'], input: SeedRowInput) {
  const [row] = await db
    .insert(syncAuditLogs)
    .values({
      orgId: input.orgId,
      entityType: 'transaction',
      localId: null,
      action: input.action,
      direction: input.direction,
      outcome: input.outcome,
      triggeringEvent: `${input.action}-event`,
      detail: { note: input.action },
      createdAt: input.createdAt,
    })
    .returning();
  if (!row) throw new Error('setup: audit log insert returned no row');
  return row;
}

describe('GET /api/sync/activity', () => {
  it('401s when unauthenticated', async () => {
    testDb = await createTestDb();
    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });

    const res = await app.inject({ method: 'GET', url: '/api/sync/activity' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('returns an empty array for an org with no activity', async () => {
    const { password, email } = await seedOrgAndUser();
    if (!testDb) throw new Error('unreachable');
    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
    const sid = await login(app, email, password);

    const res = await app.inject({ method: 'GET', url: '/api/sync/activity', cookies: { sid } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);

    await app.close();
  });

  it('returns rows newest-first, org-scoped, with real row contents', async () => {
    const orgA = await seedOrgAndUser('Org A');
    if (!testDb) throw new Error('unreachable');
    const base = new Date('2026-07-01T00:00:00.000Z');
    const oldest = await seedActivityRow(testDb.db, {
      orgId: orgA.orgId,
      action: 'qbo.connect.initiated',
      direction: 'local',
      outcome: 'success',
      createdAt: new Date(base.getTime()),
    });
    const middle = await seedActivityRow(testDb.db, {
      orgId: orgA.orgId,
      action: 'qbo.inbound.apply',
      direction: 'inbound',
      outcome: 'skipped',
      createdAt: new Date(base.getTime() + 60_000),
    });
    const newest = await seedActivityRow(testDb.db, {
      orgId: orgA.orgId,
      action: 'sync.manual_retry',
      direction: 'outbound',
      outcome: 'failure',
      createdAt: new Date(base.getTime() + 120_000),
    });

    // A second org's row must never leak into org A's read.
    const orgB = await seedOrgAndUser('Org B');
    await seedActivityRow(testDb.db, {
      orgId: orgB.orgId,
      action: 'qbo.connect.initiated',
      direction: 'local',
      outcome: 'success',
      createdAt: new Date(base.getTime() + 180_000),
    });

    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
    const sid = await login(app, orgA.email, orgA.password);

    const res = await app.inject({ method: 'GET', url: '/api/sync/activity', cookies: { sid } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(3);
    expect(body.map((r) => r.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(body[0]).toMatchObject({
      id: newest.id,
      action: 'sync.manual_retry',
      direction: 'outbound',
      outcome: 'failure',
      entityType: 'transaction',
      triggeringEvent: 'sync.manual_retry-event',
      detail: { note: 'sync.manual_retry' },
      createdAt: newest.createdAt.toISOString(),
    });
    expect(body[1]).toMatchObject({ id: middle.id, outcome: 'skipped', direction: 'inbound' });
    expect(body[2]).toMatchObject({ id: oldest.id, outcome: 'success', direction: 'local' });

    await app.close();
  });

  it("does not leak another org's activity", async () => {
    const orgA = await seedOrgAndUser('Org A');
    if (!testDb) throw new Error('unreachable');
    await seedActivityRow(testDb.db, {
      orgId: orgA.orgId,
      action: 'qbo.connect.initiated',
      direction: 'local',
      outcome: 'success',
      createdAt: new Date(),
    });

    const orgB = await seedOrgAndUser('Org B');
    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
    const sidB = await login(app, orgB.email, orgB.password);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sync/activity',
      cookies: { sid: sidB },
    });
    expect(res.json()).toEqual([]);

    await app.close();
  });

  it('caps the result at a requested `limit` and at 200 when an out-of-range value is coerced', async () => {
    const orgA = await seedOrgAndUser('Org A');
    if (!testDb) throw new Error('unreachable');
    const base = new Date('2026-07-01T00:00:00.000Z');
    for (let i = 0; i < 5; i++) {
      await seedActivityRow(testDb.db, {
        orgId: orgA.orgId,
        action: `sync.event.${i}`,
        direction: 'local',
        outcome: 'success',
        createdAt: new Date(base.getTime() + i * 60_000),
      });
    }

    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
    const sid = await login(app, orgA.email, orgA.password);

    const capped = await app.inject({
      method: 'GET',
      url: '/api/sync/activity?limit=2',
      cookies: { sid },
    });
    expect(capped.statusCode).toBe(200);
    const cappedBody = capped.json() as Array<Record<string, unknown>>;
    expect(cappedBody).toHaveLength(2);
    // Newest-first: the two most recently created rows (i=4 then i=3).
    expect(cappedBody[0]?.action).toBe('sync.event.4');
    expect(cappedBody[1]?.action).toBe('sync.event.3');

    // A limit above the schema's max (200) is a 400, not silently coerced -
    // the Fastify querystring schema itself enforces the upper bound.
    const overMax = await app.inject({
      method: 'GET',
      url: '/api/sync/activity?limit=201',
      cookies: { sid },
    });
    expect(overMax.statusCode).toBe(400);

    await app.close();
  });

  it('defaults the limit to 50 when the querystring omits it', async () => {
    const orgA = await seedOrgAndUser('Org A');
    if (!testDb) throw new Error('unreachable');
    const base = new Date('2026-07-01T00:00:00.000Z');
    for (let i = 0; i < 55; i++) {
      await seedActivityRow(testDb.db, {
        orgId: orgA.orgId,
        action: `sync.event.${i}`,
        direction: 'local',
        outcome: 'success',
        createdAt: new Date(base.getTime() + i * 60_000),
      });
    }

    const app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
    const sid = await login(app, orgA.email, orgA.password);

    const res = await app.inject({ method: 'GET', url: '/api/sync/activity', cookies: { sid } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(50);
    // Newest-first: row i=54 (the very last seeded) must be first.
    expect(body[0]?.action).toBe('sync.event.54');
    expect(body[49]?.action).toBe('sync.event.5');

    await app.close();
  });
});
