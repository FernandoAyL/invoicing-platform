import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import * as schema from '../db/schema.ts';
import { writeAuditLog } from './service.ts';

describe('writeAuditLog', () => {
  let testDb: TestDb;
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    testDb = await createTestDb();
    ({ orgId } = await seedBaseOrg(testDb.db));
    const [user] = await testDb.db
      .insert(schema.users)
      .values({ orgId, email: 'audit@invoicing.test', passwordHash: 'hash' })
      .returning();
    if (!user) throw new Error('setup: user insert returned no row');
    userId = user.id;
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it('defaults direction to local and outcome to success', async () => {
    const localId = randomUUID();

    await writeAuditLog(testDb.db, {
      orgId,
      userId,
      entityType: 'contact',
      localId,
      action: 'create',
    });

    const rows = await testDb.db.select().from(schema.syncAuditLogs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId,
      userId,
      entityType: 'contact',
      localId,
      action: 'create',
      direction: 'local',
      outcome: 'success',
      triggeringEvent: null,
    });
  });

  it('passes through explicit direction, outcome, triggeringEvent and detail', async () => {
    const localId = randomUUID();

    await writeAuditLog(testDb.db, {
      orgId,
      userId: null,
      entityType: 'contact',
      localId,
      action: 'update',
      direction: 'inbound',
      outcome: 'failure',
      triggeringEvent: 'qbo_webhook',
      detail: { fields: ['displayName'] },
    });

    const rows = await testDb.db.select().from(schema.syncAuditLogs);
    expect(rows[0]).toMatchObject({
      userId: null,
      action: 'update',
      direction: 'inbound',
      outcome: 'failure',
      triggeringEvent: 'qbo_webhook',
      detail: { fields: ['displayName'] },
    });
  });
});
