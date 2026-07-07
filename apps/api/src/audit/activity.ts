// Chronological read over `sync_audit_logs` for the Integrations page's "Sync activity log"
// (20012, `.claude/plans/20012-integrations-page.md` §2). Every sync/connection action already
// writes here via `writeAuditLog` (see `./service.ts`) - this is a pure org-scoped read, no new
// table, no migration.
import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.ts';
import { syncAuditLogs } from '../db/schema.ts';

type Db = NodePgDatabase<typeof schema>;

export interface SyncActivityRow {
  id: string;
  entityType: string | null;
  localId: string | null;
  action: string;
  direction: 'inbound' | 'outbound' | 'local';
  outcome: 'success' | 'failure' | 'skipped';
  triggeringEvent: string | null;
  detail: unknown;
  createdAt: Date;
}

export const DEFAULT_ACTIVITY_LIMIT = 50;
export const MAX_ACTIVITY_LIMIT = 200;

export async function listSyncActivity(
  db: Db,
  orgId: string,
  limit = DEFAULT_ACTIVITY_LIMIT,
): Promise<SyncActivityRow[]> {
  const cappedLimit = Math.min(Math.max(limit, 1), MAX_ACTIVITY_LIMIT);
  return (
    db
      .select()
      .from(syncAuditLogs)
      .where(eq(syncAuditLogs.orgId, orgId))
      // Stable tiebreak (`desc(id)`) so same-timestamp rows still sort deterministically.
      .orderBy(desc(syncAuditLogs.createdAt), desc(syncAuditLogs.id))
      .limit(cappedLimit)
  );
}
