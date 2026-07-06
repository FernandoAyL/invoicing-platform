import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import { processedEvents } from '../db/schema.ts';
import { buildEventKey, recordEventIfNew } from './event-dedup.ts';

describe('buildEventKey', () => {
  it('is deterministic for identical inputs', () => {
    const input = {
      realmId: 'realm-a',
      name: 'Invoice',
      id: '145',
      operation: 'Update',
      lastUpdated: '2026-07-05T00:00:00Z',
    };
    expect(buildEventKey(input)).toBe(buildEventKey({ ...input }));
  });

  it('includes lastUpdated in the key when present', () => {
    const key = buildEventKey({
      realmId: 'realm-a',
      name: 'Invoice',
      id: '145',
      operation: 'Update',
      lastUpdated: '2026-07-05T00:00:00Z',
    });
    expect(key).toBe('realm-a:Invoice:145:Update:2026-07-05T00:00:00Z');
  });

  it('falls back to the 4-tuple when lastUpdated is absent', () => {
    const key = buildEventKey({
      realmId: 'realm-a',
      name: 'Invoice',
      id: '145',
      operation: 'Update',
    });
    expect(key).toBe('realm-a:Invoice:145:Update');
  });

  it('produces distinct keys for a genuine re-edit (different lastUpdated)', () => {
    const first = buildEventKey({
      realmId: 'realm-a',
      name: 'Invoice',
      id: '145',
      operation: 'Update',
      lastUpdated: '2026-07-05T00:00:00Z',
    });
    const second = buildEventKey({
      realmId: 'realm-a',
      name: 'Invoice',
      id: '145',
      operation: 'Update',
      lastUpdated: '2026-07-06T00:00:00Z',
    });
    expect(first).not.toBe(second);
  });

  it('produces distinct keys for distinct entity ids/operations', () => {
    const base = {
      realmId: 'realm-a',
      name: 'Invoice',
      id: '145',
      operation: 'Update',
      lastUpdated: '2026-07-05T00:00:00Z',
    };
    expect(buildEventKey(base)).not.toBe(buildEventKey({ ...base, id: '146' }));
    expect(buildEventKey(base)).not.toBe(buildEventKey({ ...base, operation: 'Create' }));
    expect(buildEventKey(base)).not.toBe(buildEventKey({ ...base, name: 'Customer' }));
    expect(buildEventKey(base)).not.toBe(buildEventKey({ ...base, realmId: 'realm-b' }));
  });
});

describe('recordEventIfNew (createTestDb — real Postgres via pglite)', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  const event = {
    realmId: 'realm-a',
    name: 'Invoice',
    id: '145',
    operation: 'Update',
    lastUpdated: '2026-07-05T00:00:00Z',
  };

  it('returns true on first delivery, false on redelivery of the same event', async () => {
    const { orgId } = await seedBaseOrg(testDb.db);

    const first = await recordEventIfNew(testDb.db, { orgId, ...event });
    const second = await recordEventIfNew(testDb.db, { orgId, ...event });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('persists exactly one processed_events row after two identical calls (anti-tautology)', async () => {
    const { orgId } = await seedBaseOrg(testDb.db);

    await recordEventIfNew(testDb.db, { orgId, ...event });
    await recordEventIfNew(testDb.db, { orgId, ...event });

    const rows = await testDb.db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId,
      realmId: 'realm-a',
      entityName: 'Invoice',
      entityId: '145',
      operation: 'Update',
      eventKey: buildEventKey(event),
    });
  });

  it('returns true for two different keys (distinct lastUpdated = distinct event)', async () => {
    const { orgId } = await seedBaseOrg(testDb.db);

    const first = await recordEventIfNew(testDb.db, { orgId, ...event });
    const second = await recordEventIfNew(testDb.db, {
      orgId,
      ...event,
      lastUpdated: '2026-07-06T00:00:00Z',
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it('is org-scoped: the same event key for two different orgs both record as new', async () => {
    const { orgId: orgA } = await seedBaseOrg(testDb.db, { name: 'Org A' });
    const { orgId: orgB } = await seedBaseOrg(testDb.db, { name: 'Org B' });

    const first = await recordEventIfNew(testDb.db, { orgId: orgA, ...event });
    const second = await recordEventIfNew(testDb.db, { orgId: orgB, ...event });

    expect(first).toBe(true);
    expect(second).toBe(true);

    const rows = await testDb.db.select().from(processedEvents);
    expect(rows).toHaveLength(2);
  });
});
