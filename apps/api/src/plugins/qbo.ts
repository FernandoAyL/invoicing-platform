import fp from 'fastify-plugin';
import { config } from '../config.ts';
import { createQboApiClient, type QboApiClient } from '../qbo/api-client.ts';
import { createIntuitOAuthClient, type QboOAuthClient } from '../qbo/oauth-client.ts';

export interface QboPluginOptions {
  /** Injected for tests (a stub client), or explicit `null` to force the "not configured" 503
   * path without touching env vars. Omitted in production, where it's built from `config.qbo`. */
  qboOAuthClient?: QboOAuthClient | null;
  /** Injected for tests (a fake client), or explicit `null` to force the "not configured" path.
   * Omitted in production, where it's built from `config.qbo`. */
  qboApiClient?: QboApiClient | null;
  /** Injected for tests (a known verifier token so tests can compute a valid signature), or
   * explicit `null` to force the webhook's 503 "not configured" path. Omitted in production,
   * where it's read from `config.qbo?.webhookVerifierToken`. */
  qboWebhookVerifierToken?: string | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    qboOAuthClient: QboOAuthClient | null;
    qboApiClient: QboApiClient | null;
    qboWebhookVerifierToken: string | null;
  }
}

export default fp<QboPluginOptions>(async (app, opts) => {
  const client =
    opts.qboOAuthClient !== undefined
      ? opts.qboOAuthClient
      : config.qbo
        ? createIntuitOAuthClient(config.qbo)
        : null;

  const apiClient =
    opts.qboApiClient !== undefined
      ? opts.qboApiClient
      : config.qbo
        ? createQboApiClient({ environment: config.qbo.environment })
        : null;

  const webhookVerifierToken =
    opts.qboWebhookVerifierToken !== undefined
      ? opts.qboWebhookVerifierToken
      : (config.qbo?.webhookVerifierToken ?? null);

  app.decorate('qboOAuthClient', client);
  app.decorate('qboApiClient', apiClient);
  app.decorate('qboWebhookVerifierToken', webhookVerifierToken);
});
