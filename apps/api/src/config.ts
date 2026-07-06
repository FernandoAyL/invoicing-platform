export interface QboConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: 'sandbox' | 'production';
  /** Intuit's "Webhook Verifier Token" — a distinct secret from the OAuth client secret, used to
   * verify the `intuit-signature` header on inbound webhooks. Independently optional: may be null
   * even when the OAuth trio above is fully configured. */
  webhookVerifierToken: string | null;
}

export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  sessionTtlHours: number;
  /** Null when the QUICKBOOKS_* env vars aren't fully set — the integration is optional. */
  qbo: QboConfig | null;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

// Deliberately non-throwing: QBO is an optional integration. Partially-set vars are treated the
// same as unset (null) rather than a hard error, so a half-configured environment fails closed
// (routes 503) instead of crashing the whole app on boot.
function loadQboConfig(env: NodeJS.ProcessEnv): QboConfig | null {
  const clientId = env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = env.QUICKBOOKS_CLIENT_SECRET;
  const redirectUri = env.QUICKBOOKS_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return {
    clientId,
    clientSecret,
    redirectUri,
    environment: env.QUICKBOOKS_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    webhookVerifierToken: env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN || null,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Object.freeze({
    nodeEnv: env.NODE_ENV ?? 'development',
    port: positiveInt(env, 'PORT', 8080),
    databaseUrl: required(env, 'DATABASE_URL'),
    sessionSecret: required(env, 'SESSION_SECRET'),
    sessionTtlHours: positiveInt(env, 'SESSION_TTL_HOURS', 168),
    qbo: loadQboConfig(env),
  });
}

export const config: Config = loadConfig();
