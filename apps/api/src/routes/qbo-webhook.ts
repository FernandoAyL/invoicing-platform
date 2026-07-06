import type { FastifyInstance } from 'fastify';
import { writeAuditLog } from '../audit/service.ts';
import type { QboEntityEnvelope } from '../qbo/api-client.ts';
import { getConnectionByRealmId } from '../qbo/connection-service.ts';
import { QboNotConnectedError } from '../qbo/errors.ts';
import { recordEventIfNew } from '../qbo/event-dedup.ts';
import { applyInboundEntity } from '../qbo/inbound-sync.ts';
import { mapNotificationToEntityType, refetchEntity } from '../qbo/refetch.ts';
import { verifyWebhookSignature } from '../qbo/webhook-signature.ts';
import {
  parseWebhookNotifications,
  type WebhookBody,
  webhookBodySchema,
} from '../qbo/webhook-types.ts';

/** Tagged error the local content-type parser raises for auth/config failures, so the local
 * error handler can map it to the right status code without touching Fastify's default
 * validation-error formatting for everything else. */
class QboWebhookError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'QboWebhookError';
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default async function qboWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulated to this plugin only (Fastify scopes content-type parsers to the registering
  // instance and its children) — the global 'application/json' parser used by every other route
  // is untouched. Verifies the Intuit signature over the raw body before any trust in the parsed
  // JSON, then hands the parsed object to the route's schema validation.
  app.addContentTypeParser<string>(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      const token = app.qboWebhookVerifierToken;
      if (!token) {
        done(new QboWebhookError(503, 'qbo_webhook_not_configured'));
        return;
      }

      const signatureHeader = request.headers['intuit-signature'];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      if (!verifyWebhookSignature(body, signature, token)) {
        done(new QboWebhookError(401, 'invalid_signature'));
        return;
      }

      try {
        done(null, JSON.parse(body));
      } catch {
        done(new QboWebhookError(400, 'invalid_json'));
      }
    },
  );

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof QboWebhookError) {
      reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    reply.send(err);
  });

  app.post<{ Body: WebhookBody }>(
    '/api/integrations/qbo/webhook',
    { schema: { body: webhookBodySchema } },
    async (request, reply) => {
      const notifications = parseWebhookNotifications(request.body);

      for (const notification of notifications) {
        const connection = await getConnectionByRealmId(app.db, notification.realmId);
        if (!connection) {
          // Ack fast, don't error: an unresolvable realm must never trigger an Intuit retry
          // storm. There's no orgId to attribute an audit row to, so just log it.
          app.log.warn({ realmId: notification.realmId }, 'qbo webhook: unknown realmId, skipping');
          continue;
        }

        for (const entity of notification.entities) {
          const triggeringEvent = `${notification.realmId}:${entity.name}:${entity.id}:${entity.operation}`;
          const entityType = mapNotificationToEntityType(entity.name);

          if (!entityType) {
            // A notification type this sync engine never maps (e.g. `Preferences`) — record it
            // was seen and move on. No `processed_events` claim: there's nothing to apply or
            // retry, so redelivery just writing another breadcrumb here is harmless.
            await writeAuditLog(app.db, {
              orgId: connection.orgId,
              userId: null,
              entityType: entity.name,
              localId: null,
              action: 'qbo.webhook.unmapped',
              direction: 'inbound',
              outcome: 'skipped',
              triggeringEvent,
              detail: entity,
            });
            continue;
          }

          // Refetch the authoritative QBO state OUTSIDE any transaction — a network call must
          // never hold a DB transaction open (§0a.1). A refetch failure must never claim the
          // event: leave `processed_events` untouched so Intuit's redelivery re-drives it once
          // the transient condition (or reconnect) clears.
          let refetched: QboEntityEnvelope;
          try {
            if (!app.qboOAuthClient || !app.qboApiClient) {
              throw new QboNotConnectedError('QBO integration not configured for inbound refetch');
            }
            refetched = await refetchEntity(
              { db: app.db, oauthClient: app.qboOAuthClient, apiClient: app.qboApiClient },
              { orgId: connection.orgId, entityType, qboId: entity.id },
            );
          } catch (err) {
            await writeAuditLog(app.db, {
              orgId: connection.orgId,
              userId: null,
              entityType: entity.name,
              localId: null,
              action: 'qbo.webhook.refetch_failed',
              direction: 'inbound',
              outcome: 'failure',
              triggeringEvent,
              detail: { ...entity, error: errMessage(err) },
            });
            continue;
          }

          // Claim + apply atomically (§0a.1 — the correctness fix carried from 20005's review):
          // `recordEventIfNew` and `applyInboundEntity` share this SAME `tx`. If anything inside
          // throws, the whole transaction — the dedup claim included — rolls back, so a crash
          // between claiming and finishing the apply looks like "never claimed" to the next
          // redelivery. No dropped events, and the refetch network call above never held this
          // transaction open.
          await app.db.transaction(async (tx) => {
            const isNew = await recordEventIfNew(tx, {
              orgId: connection.orgId,
              realmId: notification.realmId,
              name: entity.name,
              id: entity.id,
              operation: entity.operation,
              lastUpdated: entity.lastUpdated,
            });

            if (!isNew) {
              // Redelivery of an event already recorded (same realm/entity/operation/lastUpdated):
              // skip the apply, but leave one `duplicate` breadcrumb so the Integrations activity
              // log (20012) can show it wasn't silently lost.
              await writeAuditLog(tx, {
                orgId: connection.orgId,
                userId: null,
                entityType: entity.name,
                localId: null,
                action: 'qbo.webhook.duplicate',
                direction: 'inbound',
                outcome: 'skipped',
                triggeringEvent,
                detail: entity,
              });
              return;
            }

            await applyInboundEntity(tx, {
              orgId: connection.orgId,
              realmId: notification.realmId,
              entityType,
              entity,
              refetched,
            });
          });
        }
      }

      reply.code(200);
      return { ok: true };
    },
  );
}
