import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { writeAuditLog } from '../audit/service.ts';
import { config } from '../config.ts';
import { requireUser } from '../plugins/auth.ts';
import {
  connectionStatus,
  deleteConnection,
  getConnection,
  upsertConnection,
} from '../qbo/connection-service.ts';
import { signState, verifyState } from '../qbo/oauth-state.ts';

interface CallbackQuery {
  code: string;
  state: string;
  realmId: string;
}

const callbackQuerySchema = {
  type: 'object',
  required: ['code', 'state', 'realmId'],
  properties: {
    code: { type: 'string', minLength: 1 },
    state: { type: 'string', minLength: 1 },
    realmId: { type: 'string', minLength: 1 },
  },
} as const;

export default async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/integrations/qbo/connect',
    { preHandler: app.requireRole('admin') },
    async (request, reply) => {
      const user = requireUser(request);
      if (!app.qboOAuthClient) {
        reply.code(503).send({ error: 'qbo_not_configured' });
        return;
      }

      const state = signState(config.sessionSecret, user.orgId, randomUUID());
      const authorizeUrl = app.qboOAuthClient.authorizeUrl({ state });

      await writeAuditLog(app.db, {
        orgId: user.orgId,
        userId: user.id,
        entityType: 'qbo_connection',
        localId: user.orgId,
        action: 'qbo.connect.initiated',
        direction: 'local',
      });

      return { authorizeUrl };
    },
  );

  app.get<{ Querystring: CallbackQuery }>(
    '/api/integrations/qbo/callback',
    { schema: { querystring: callbackQuerySchema }, preHandler: app.requireRole('admin') },
    async (request, reply) => {
      const user = requireUser(request);
      if (!app.qboOAuthClient) {
        reply.code(503).send({ error: 'qbo_not_configured' });
        return;
      }

      const { code, state, realmId } = request.query;
      const payload = verifyState(config.sessionSecret, state);
      if (!payload || payload.orgId !== user.orgId) {
        await writeAuditLog(app.db, {
          orgId: user.orgId,
          userId: user.id,
          entityType: 'qbo_connection',
          localId: user.orgId,
          action: 'qbo.connect.callback',
          direction: 'inbound',
          outcome: 'failure',
          detail: { reason: 'invalid_state' },
        });
        reply.code(400).send({ error: 'invalid_state' });
        return;
      }

      try {
        const tokens = await app.qboOAuthClient.exchangeCode(code);
        await upsertConnection(app.db, user.orgId, { ...tokens, realmId });
        await writeAuditLog(app.db, {
          orgId: user.orgId,
          userId: user.id,
          entityType: 'qbo_connection',
          localId: user.orgId,
          action: 'qbo.connect.callback',
          direction: 'inbound',
          outcome: 'success',
        });
        reply.redirect('/integrations?connected=1');
      } catch (err) {
        await writeAuditLog(app.db, {
          orgId: user.orgId,
          userId: user.id,
          entityType: 'qbo_connection',
          localId: user.orgId,
          action: 'qbo.connect.callback',
          direction: 'inbound',
          outcome: 'failure',
          detail: { reason: err instanceof Error ? err.message : 'exchange_failed' },
        });
        reply.redirect('/integrations?error=qbo_connect_failed');
      }
    },
  );

  app.get(
    '/api/integrations/qbo/status',
    // Read-only for any authed org member (not admin-only) - `connectionStatus()` never
    // serializes tokens, so members seeing connection health is safe. Only connect/callback/
    // disconnect stay admin-gated (20012 Revision 1: the Integrations page reads status for
    // every authed user and only hides the Connect/Disconnect actions for non-admins).
    { preHandler: app.authenticate },
    async (request) => {
      const user = requireUser(request);
      return connectionStatus(app.db, user.orgId);
    },
  );

  app.post(
    '/api/integrations/qbo/disconnect',
    { preHandler: app.requireRole('admin') },
    async (request) => {
      const user = requireUser(request);

      const connection = await getConnection(app.db, user.orgId);
      if (connection && app.qboOAuthClient) {
        // Best-effort: Intuit may have already dropped the token on its side. A flaky/failed
        // revoke must not block the local disconnect.
        try {
          await app.qboOAuthClient.revoke(connection.refreshToken);
        } catch {
          // swallowed intentionally
        }
      }

      const existed = await deleteConnection(app.db, user.orgId);
      await writeAuditLog(app.db, {
        orgId: user.orgId,
        userId: user.id,
        entityType: 'qbo_connection',
        localId: user.orgId,
        action: 'qbo.disconnect',
        direction: 'local',
        outcome: 'success',
        detail: { existed },
      });

      return { connected: false };
    },
  );
}
