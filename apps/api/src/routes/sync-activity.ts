// Sync activity log route (20012, `.claude/plans/20012-integrations-page.md` §2). `GET
// /api/sync/activity` is an org-scoped, newest-first, chronological read over `sync_audit_logs`
// for the Integrations page - the one new backend piece this task adds (connect/disconnect/status
// live in `integrations.ts`, failed-item list + retry in `sync-failures.ts`, conflicts in
// `conflicts.ts`, all pre-existing).
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_ACTIVITY_LIMIT,
  listSyncActivity,
  type SyncActivityRow,
} from '../audit/activity.ts';
import { requireUser } from '../plugins/auth.ts';

interface ActivityQuery {
  limit?: number;
}

const activityQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
} as const;

function serializeActivity(row: SyncActivityRow) {
  return {
    id: row.id,
    entityType: row.entityType,
    localId: row.localId,
    action: row.action,
    direction: row.direction,
    outcome: row.outcome,
    triggeringEvent: row.triggeringEvent,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

export default async function syncActivityRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ActivityQuery }>(
    '/api/sync/activity',
    { schema: { querystring: activityQuerySchema }, preHandler: app.authenticate },
    async (request) => {
      const user = requireUser(request);

      const rows = await listSyncActivity(
        app.db,
        user.orgId,
        request.query.limit ?? DEFAULT_ACTIVITY_LIMIT,
      );
      return rows.map(serializeActivity);
    },
  );
}
