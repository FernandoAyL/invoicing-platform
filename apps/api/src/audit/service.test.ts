import { describe, expect, it } from 'vitest';
import * as schema from '../db/schema.ts';
import { writeAuditLog } from './service.ts';

function createFakeDb() {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    insert(table: unknown) {
      if (table !== schema.syncAuditLogs) {
        throw new Error('fakeDb: unsupported insert().values() table');
      }
      return {
        values(vals: Record<string, unknown>) {
          inserted.push(vals);
          return Promise.resolve(undefined);
        },
      };
    },
  };
  return { db, inserted };
}

describe('writeAuditLog', () => {
  it('defaults direction to local and outcome to success', async () => {
    const { db, inserted } = createFakeDb();

    await writeAuditLog(db as unknown as Parameters<typeof writeAuditLog>[0], {
      orgId: 'org-1',
      userId: 'user-1',
      entityType: 'contact',
      localId: 'contact-1',
      action: 'create',
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      orgId: 'org-1',
      userId: 'user-1',
      entityType: 'contact',
      localId: 'contact-1',
      action: 'create',
      direction: 'local',
      outcome: 'success',
      triggeringEvent: null,
    });
  });

  it('passes through explicit direction, outcome, triggeringEvent and detail', async () => {
    const { db, inserted } = createFakeDb();

    await writeAuditLog(db as unknown as Parameters<typeof writeAuditLog>[0], {
      orgId: 'org-1',
      userId: null,
      entityType: 'contact',
      localId: 'contact-1',
      action: 'update',
      direction: 'inbound',
      outcome: 'failure',
      triggeringEvent: 'qbo_webhook',
      detail: { fields: ['displayName'] },
    });

    expect(inserted[0]).toMatchObject({
      userId: null,
      action: 'update',
      direction: 'inbound',
      outcome: 'failure',
      triggeringEvent: 'qbo_webhook',
      detail: { fields: ['displayName'] },
    });
  });
});
