import type { FastifyInstance } from 'fastify';
import { writeAuditLog } from '../audit/service.ts';
import { getConnectionByRealmId } from '../qbo/connection-service.ts';
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
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'QboWebhookError';
  }
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
          await writeAuditLog(app.db, {
            orgId: connection.orgId,
            userId: null,
            entityType: entity.name,
            localId: entity.id,
            action: 'qbo.webhook.received',
            direction: 'inbound',
            outcome: 'success',
            triggeringEvent: `${notification.realmId}:${entity.name}:${entity.id}:${entity.operation}`,
            detail: entity,
          });
        }
      }

      reply.code(200);
      return { ok: true };
    },
  );
}
