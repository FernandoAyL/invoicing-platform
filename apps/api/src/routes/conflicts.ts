// Conflict resolution routes (20010, `.claude/plans/20010-conflict-detection.md` §0a.4 /
// docs/design-decisions.md ## Conflict resolution). `GET /api/conflicts` lists every `sync_links`
// row in `conflict` state, joined to its local transaction for display. `POST
// /api/conflicts/:linkId/resolve` picks a winner and re-drives sync — no merge, ever: `local`
// force-pushes the current local record to QBO (bypassing the conflict + already-current
// guards), `qbo` refetches the QBO version and applies it locally (bypassing the conflict check),
// through the exact same apply/push machinery every other sync uses.
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { writeAuditLog } from '../audit/service.ts';
import { syncAuditLogs, syncLinks, transactions } from '../db/schema.ts';
import { requireUser } from '../plugins/auth.ts';
import type { QboEntityType } from '../qbo/api-client.ts';
import { getValidAccessToken } from '../qbo/connection-service.ts';
import { applyInboundEntity } from '../qbo/inbound-sync.ts';
import { syncInvoiceOutbound, syncPaymentOutbound } from '../qbo/outbound-sync.ts';
import { findLinkById } from '../qbo/sync-link-service.ts';

interface ResolveConflictBody {
  winner: 'local' | 'qbo';
}

const resolveConflictBodySchema = {
  type: 'object',
  required: ['winner'],
  additionalProperties: false,
  properties: {
    winner: { type: 'string', enum: ['local', 'qbo'] },
  },
} as const;

const linkIdParamSchema = {
  type: 'object',
  required: ['linkId'],
  properties: {
    linkId: { type: 'string', format: 'uuid' },
  },
} as const;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Recovers the webhook `operation` (Update/Void/Delete) to replay for `winner:'qbo'`, by reading
 * it back off the `qbo.inbound.conflict` / `qbo.inbound.conflict_held` audit trail (`detail.
 * operation`, stamped by `audit()` in `inbound-sync.ts`). This resolution route is user-initiated,
 * not a webhook redelivery, so it has no `operation` of its own to replay — reusing the audit
 * trail means no extra schema is needed to carry it.
 *
 * **Terminal-operation precedence: Delete > Void > Update.** Picking the single MOST RECENT audit
 * row is wrong: a link can be held in conflict across several inbound events (decision #3 —
 * `handleAlreadyConflictHold` re-audits every subsequent non-stale event while still `conflict`,
 * without applying it), and a later event can be a plain metadata `Update` even though an earlier
 * event already told us QBO voided or deleted the record. QBO void/delete are terminal — you
 * cannot meaningfully "update" a voided/deleted QBO entity — so if ANY conflict/held row recorded
 * since this link most recently entered conflict (`>= conflictDetectedAt`) was a Void or Delete,
 * that IS QBO's true current state and must win over a later Update row. Only when no Void/Delete
 * row exists do we fall back to the (single) Update — or `'Update'` itself if no row exists at
 * all, which should not happen for a link genuinely in `conflict` state.
 */
async function recoverConflictOperation(
  app: FastifyInstance,
  orgId: string,
  localId: string,
  since: Date | null,
): Promise<string> {
  const conditions = [
    eq(syncAuditLogs.orgId, orgId),
    eq(syncAuditLogs.localId, localId),
    inArray(syncAuditLogs.action, ['qbo.inbound.conflict', 'qbo.inbound.conflict_held']),
  ];
  if (since) conditions.push(gte(syncAuditLogs.createdAt, since));

  const rows = await app.db
    .select()
    .from(syncAuditLogs)
    .where(and(...conditions))
    .orderBy(desc(syncAuditLogs.createdAt));

  const operations = rows
    .map((row) => (row.detail as Record<string, unknown> | null)?.operation)
    .filter((op): op is string => typeof op === 'string');

  if (operations.includes('Delete')) return 'Delete';
  if (operations.includes('Void')) return 'Void';
  return operations[0] ?? 'Update';
}

function serializeConflict(
  link: typeof syncLinks.$inferSelect,
  txn: typeof transactions.$inferSelect | undefined,
) {
  return {
    linkId: link.id,
    qboType: link.qboType,
    qboId: link.qboId,
    conflictDetectedAt: link.conflictDetectedAt,
    storedSyncToken: link.qboSyncToken,
    storedLocalVersion: link.localVersion,
    localCurrentVersion: txn?.version ?? null,
    transaction: txn
      ? {
          id: txn.id,
          type: txn.type,
          docNumber: txn.docNumber,
          total: txn.total,
          status: txn.status,
          deletedAt: txn.deletedAt,
          updatedAt: txn.updatedAt,
        }
      : null,
  };
}

export default async function conflictRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/conflicts', { preHandler: app.authenticate }, async (request) => {
    const user = requireUser(request);

    const rows = await app.db
      .select({ link: syncLinks, txn: transactions })
      .from(syncLinks)
      .leftJoin(
        transactions,
        and(eq(transactions.id, syncLinks.localId), eq(transactions.orgId, syncLinks.orgId)),
      )
      .where(and(eq(syncLinks.orgId, user.orgId), eq(syncLinks.state, 'conflict')));

    return rows.map((row) => serializeConflict(row.link, row.txn ?? undefined));
  });

  app.post<{ Params: { linkId: string }; Body: ResolveConflictBody }>(
    '/api/conflicts/:linkId/resolve',
    {
      schema: { params: linkIdParamSchema, body: resolveConflictBodySchema },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const user = requireUser(request);

      const link = await findLinkById(app.db, user.orgId, request.params.linkId);
      if (!link) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (link.state !== 'conflict') {
        reply.code(409).send({ error: 'invalid_state', message: 'link is not in conflict' });
        return;
      }
      if (link.qboType !== 'Invoice' && link.qboType !== 'Payment') {
        reply
          .code(409)
          .send({ error: 'invalid_state', message: `unsupported qboType: ${link.qboType}` });
        return;
      }

      if (request.body.winner === 'local') {
        await resolveWithLocal(app, reply, user, link);
        return;
      }
      await resolveWithQbo(app, reply, user, link);
    },
  );
}

async function resolveWithLocal(
  app: FastifyInstance,
  reply: FastifyReply,
  user: { orgId: string; id: string },
  link: typeof syncLinks.$inferSelect,
): Promise<void> {
  const syncFn = link.qboType === 'Invoice' ? syncInvoiceOutbound : syncPaymentOutbound;

  try {
    if (!app.qboOAuthClient || !app.qboApiClient) {
      throw new Error('QBO integration not configured');
    }
    const { accessToken, realmId } = await getValidAccessToken(
      app.db,
      app.qboOAuthClient,
      user.orgId,
    );
    const result = await syncFn(
      app.db,
      { client: app.qboApiClient, realmId, accessToken },
      { orgId: user.orgId, txnId: link.localId, userId: user.id, force: true },
    );

    if (result.status !== 'synced') {
      await writeAuditLog(app.db, {
        orgId: user.orgId,
        userId: user.id,
        entityType: 'transaction',
        localId: link.localId,
        action: 'conflict.resolve_failed',
        direction: 'local',
        outcome: 'failure',
        detail: { winner: 'local', linkId: link.id, reason: result.reason ?? result.status },
      });
      reply.code(502).send({ error: 'resolve_failed', reason: result.reason ?? result.status });
      return;
    }

    await writeAuditLog(app.db, {
      orgId: user.orgId,
      userId: user.id,
      entityType: 'transaction',
      localId: link.localId,
      action: 'conflict.resolved',
      direction: 'local',
      outcome: 'success',
      detail: { winner: 'local', linkId: link.id, qboId: result.qboId },
    });
    reply.send({ linkId: link.id, state: 'synced', winner: 'local' });
  } catch (err) {
    await writeAuditLog(app.db, {
      orgId: user.orgId,
      userId: user.id,
      entityType: 'transaction',
      localId: link.localId,
      action: 'conflict.resolve_failed',
      direction: 'local',
      outcome: 'failure',
      detail: { winner: 'local', linkId: link.id, error: errMessage(err) },
    });
    reply.code(502).send({ error: 'resolve_failed', message: errMessage(err) });
  }
}

async function resolveWithQbo(
  app: FastifyInstance,
  reply: FastifyReply,
  user: { orgId: string; id: string },
  link: typeof syncLinks.$inferSelect,
): Promise<void> {
  const qboType = link.qboType as QboEntityType;

  // 20011 §0a.1 (qboId audit): `sync_links.qboId` is now nullable, but a link only ever reaches
  // `conflict` after a prior successful sync (both `markConflict` call sites — the outbound
  // force-push guard and the inbound apply seam — only ever act on an already-linked record), so
  // this should never actually be null for a link this route accepts (`state === 'conflict'`,
  // checked by the caller). Guarded defensively rather than asserted, so a violated invariant
  // surfaces as a clean 409 instead of a runtime crash.
  if (!link.qboId) {
    await writeAuditLog(app.db, {
      orgId: user.orgId,
      userId: user.id,
      entityType: 'transaction',
      localId: link.localId,
      action: 'conflict.resolve_failed',
      direction: 'local',
      outcome: 'failure',
      detail: { winner: 'qbo', linkId: link.id, reason: 'link_missing_qbo_id' },
    });
    reply.code(409).send({ error: 'invalid_state', message: 'conflict link has no qboId' });
    return;
  }
  // Narrowing `link.qboId` above doesn't survive into the `db.transaction((tx) => ...)` closure
  // below (TS drops property narrowing across a function boundary) — capture it in its own
  // binding so the type stays `string` where it's used further down.
  const qboId = link.qboId;

  try {
    if (!app.qboOAuthClient || !app.qboApiClient) {
      throw new Error('QBO integration not configured');
    }

    // Refetch OUTSIDE any transaction (same rule as the webhook path, `inbound-sync.ts` §0a.1) —
    // a network call must never hold a DB transaction open.
    const { accessToken, realmId } = await getValidAccessToken(
      app.db,
      app.qboOAuthClient,
      user.orgId,
    );
    const refetched = await app.qboApiClient.getEntity({
      realmId,
      accessToken,
      entityType: qboType,
      qboId,
    });

    const operation = await recoverConflictOperation(
      app,
      user.orgId,
      link.localId,
      link.conflictDetectedAt,
    );

    const result = await app.db.transaction((tx) =>
      applyInboundEntity(tx, {
        orgId: user.orgId,
        realmId,
        entityType: qboType,
        entity: { name: qboType, id: qboId, operation },
        refetched,
        bypassConflict: true,
      }),
    );

    if (result.action !== 'updated' && result.action !== 'voided' && result.action !== 'deleted') {
      await writeAuditLog(app.db, {
        orgId: user.orgId,
        userId: user.id,
        entityType: 'transaction',
        localId: link.localId,
        action: 'conflict.resolve_failed',
        direction: 'local',
        outcome: 'failure',
        detail: { winner: 'qbo', linkId: link.id, reason: result.reason ?? result.action },
      });
      reply.code(502).send({ error: 'resolve_failed', reason: result.reason ?? result.action });
      return;
    }

    await writeAuditLog(app.db, {
      orgId: user.orgId,
      userId: user.id,
      entityType: 'transaction',
      localId: link.localId,
      action: 'conflict.resolved',
      direction: 'local',
      outcome: 'success',
      detail: { winner: 'qbo', linkId: link.id, appliedAction: result.action },
    });
    reply.send({ linkId: link.id, state: 'synced', winner: 'qbo' });
  } catch (err) {
    await writeAuditLog(app.db, {
      orgId: user.orgId,
      userId: user.id,
      entityType: 'transaction',
      localId: link.localId,
      action: 'conflict.resolve_failed',
      direction: 'local',
      outcome: 'failure',
      detail: { winner: 'qbo', linkId: link.id, error: errMessage(err) },
    });
    reply.code(502).send({ error: 'resolve_failed', message: errMessage(err) });
  }
}
