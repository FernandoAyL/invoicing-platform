import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema.ts';
import { createTestDb, seedBaseOrg, type TestDb } from './test-db.ts';

describe('createTestDb', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it('boots with the real migrations applied (organizations table is queryable and empty)', async () => {
    const rows = await testDb.db.select().from(schema.organizations);
    expect(rows).toEqual([]);
  });

  it('seedBaseOrg inserts a real row and returns its id', async () => {
    const { orgId } = await seedBaseOrg(testDb.db);

    const rows = await testDb.db.select().from(schema.organizations);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(orgId);
  });

  it('rejects a non-uuid value inserted into a uuid column — the 20002-class bug the fake db missed', async () => {
    const { orgId } = await seedBaseOrg(testDb.db);

    // `localId` is a `uuid` column (see schema.ts). The hand-rolled fake db's insert() just
    // pushed this straight into a JS array — no type enforcement — which is exactly how the
    // 20002 uuid-column bug got past the whole test suite. A real Postgres (pglite) rejects it.
    await expect(
      testDb.db.insert(schema.syncAuditLogs).values({
        orgId,
        entityType: 'Invoice',
        localId: 'not-a-uuid',
        action: 'qbo.webhook.received',
        direction: 'inbound',
        outcome: 'success',
      }),
    ).rejects.toThrow();
  });
});
