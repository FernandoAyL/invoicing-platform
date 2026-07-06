import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { config } from './config.ts';
import type * as schema from './db/schema.ts';
import authPlugin from './plugins/auth.ts';
import dbPlugin from './plugins/db.ts';
import qboPlugin from './plugins/qbo.ts';
import type { QboOAuthClient } from './qbo/oauth-client.ts';
import accountRoutes from './routes/accounts.ts';
import authRoutes from './routes/auth.ts';
import contactRoutes from './routes/contacts.ts';
import healthRoutes from './routes/health.ts';
import integrationRoutes from './routes/integrations.ts';
import invoiceRoutes from './routes/invoices.ts';
import paymentRoutes from './routes/payments.ts';
import qboWebhookRoutes from './routes/qbo-webhook.ts';

export interface BuildAppOptions {
  pool?: pg.Pool;
  db?: NodePgDatabase<typeof schema>;
  /** Injected QBO OAuth client (a stub in tests) or `null` to force the "not configured" path.
   * Omitted in production — built from `config.qbo` by `qboPlugin`. */
  qboOAuthClient?: QboOAuthClient | null;
  /** Injected verifier token for tests (so a test can compute a valid `intuit-signature`), or
   * `null` to force the webhook's 503 "not configured" path. Omitted in production — built from
   * `config.qbo?.webhookVerifierToken` by `qboPlugin`. */
  qboWebhookVerifierToken?: string | null;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(config.nodeEnv === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
    // Fastify's default ajv config silently strips unknown properties
    // instead of rejecting them; disable that so `additionalProperties:
    // false` in route schemas actually produces a 400.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.register(dbPlugin, { pool: opts.pool, db: opts.db });
  app.register(authPlugin);
  app.register(qboPlugin, {
    qboOAuthClient: opts.qboOAuthClient,
    qboWebhookVerifierToken: opts.qboWebhookVerifierToken,
  });
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(contactRoutes);
  app.register(accountRoutes);
  app.register(invoiceRoutes);
  app.register(paymentRoutes);
  app.register(integrationRoutes);
  app.register(qboWebhookRoutes);

  return app;
}
