// Failed-item / retry-queue routes (20011, `.claude/plans/20011-failure-handling.md` §0a.6). `GET
// /api/sync/failures` lists every `sync_links` row in `failed` state for the caller's org, joined
// to its local transaction for display (ref-entity links — contact/account/item — have no
// transaction to join, so that field is null for them). `POST
// /api/sync/failures/:linkId/retry` forces an immediate retry attempt on one link, ignoring its
// `nextRetryAt` backoff. Both are org-scoped: a cross-org linkId is invisible (404), never a leak.
//
// Deliberately does NOT build the Integrations page/UI or a manual-retry button — that's 20012.
// This ships the API the button will call.
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { writeAuditLog } from '../audit/service.ts';
import { type syncLinks, transactions } from '../db/schema.ts';
import { resolveOutboundDeps } from '../qbo/outbound-sync.ts';
import { retryOneFailedLink } from '../qbo/retry-sweep.ts';
import { findFailedLinksForOrg, findLinkById } from '../qbo/sync-link-service.ts';

const linkIdParamSchema = {
  type: 'object',
  required: ['linkId'],
  properties: {
    linkId: { type: 'string', format: 'uuid' },
  },
} as const;

function serializeFailure(
  link: typeof syncLinks.$inferSelect,
  txn: typeof transactions.$inferSelect | undefined,
) {
  return {
    linkId: link.id,
    entityType: link.entityType,
    qboType: link.qboType,
    qboId: link.qboId,
    retryCount: link.retryCount,
    nextRetryAt: link.nextRetryAt,
    lastError: link.lastError,
    transaction: txn
      ? {
          id: txn.id,
          type: txn.type,
          docNumber: txn.docNumber,
          total: txn.total,
          status: txn.status,
        }
      : null,
  };
}

export default async function syncFailureRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sync/failures', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }

    const links = await findFailedLinksForOrg(app.db, user.orgId);
    const txnLinkIds = links
      .filter((link) => link.entityType === 'transaction')
      .map((link) => link.localId);

    const txns =
      txnLinkIds.length === 0
        ? []
        : await app.db
            .select()
            .from(transactions)
            .where(and(eq(transactions.orgId, user.orgId), inArray(transactions.id, txnLinkIds)));

    const txnById = new Map(txns.map((t) => [t.id, t]));
    return links.map((link) => serializeFailure(link, txnById.get(link.localId)));
  });

  app.post<{ Params: { linkId: string } }>(
    '/api/sync/failures/:linkId/retry',
    { schema: { params: linkIdParamSchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }

      const link = await findLinkById(app.db, user.orgId, request.params.linkId);
      if (!link) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (link.state !== 'failed') {
        reply.code(409).send({ error: 'invalid_state', message: 'link is not in failed state' });
        return;
      }

      const deps = await resolveOutboundDeps({
        db: app.db,
        oauthClient: app.qboOAuthClient,
        apiClient: app.qboApiClient,
        orgId: user.orgId,
      });
      if (!deps) {
        reply.code(503).send({ error: 'qbo_not_connected' });
        return;
      }

      const outcome = await retryOneFailedLink(app.db, deps, link);
      const updated = await findLinkById(app.db, user.orgId, link.id);

      // 'cleared' (20011 code-review fix): the link was a never-synced retry-queue entry whose
      // local record turned out to already be terminal (deleted/voided) — there was genuinely
      // nothing left to sync, so this is a successful resolution of the queue item, not a
      // failure. `updated` is null in this case (the row was removed), not merely stale.
      await writeAuditLog(app.db, {
        orgId: user.orgId,
        userId: user.id,
        entityType: link.entityType,
        localId: link.localId,
        action: 'sync.manual_retry',
        direction: 'outbound',
        outcome: outcome === 'succeeded' || outcome === 'cleared' ? 'success' : 'failure',
        detail: { linkId: link.id, outcome, qboId: updated?.qboId ?? null },
      });

      reply.send({
        linkId: link.id,
        outcome,
        state: updated?.state ?? null,
        qboId: updated?.qboId ?? null,
      });
    },
  );
}
