import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.ts';
import { syncAuditLogs } from '../db/schema.ts';

type Db = NodePgDatabase<typeof schema>;
// The audit helper is called both with the top-level db and with the `tx`
// handle inside `db.transaction(async (tx) => ...)`, so it accepts either.
type Tx = Parameters<Db['transaction']>[0] extends (tx: infer T, ...args: never[]) => unknown
  ? T
  : never;
type DbOrTx = Db | Tx;

export interface AuditEntry {
  orgId: string;
  userId: string | null;
  entityType: string;
  localId: string;
  action: string;
  direction?: 'inbound' | 'outbound' | 'local';
  outcome?: 'success' | 'failure' | 'skipped';
  triggeringEvent?: string | null;
  detail?: unknown;
}

export async function writeAuditLog(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(syncAuditLogs).values({
    orgId: entry.orgId,
    userId: entry.userId,
    entityType: entry.entityType,
    localId: entry.localId,
    action: entry.action,
    direction: entry.direction ?? 'local',
    outcome: entry.outcome ?? 'success',
    triggeringEvent: entry.triggeringEvent ?? null,
    detail: entry.detail,
  });
}
