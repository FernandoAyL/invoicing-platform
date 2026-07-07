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

export interface SyncRetryConfig {
  /** Gates the guarded `setInterval` started in `index.ts` (never `app.ts` — tests must not spawn
   * a timer). Defaults on: `SYNC_RETRY_ENABLED=false` is the explicit opt-out. */
  enabled: boolean;
  /** How often the sweep tick runs, in ms. Independent of the per-link backoff computed by
   * `qbo/retry.ts`'s `computeBackoff` — this is just the polling cadence that checks for due
   * links, not the backoff delay itself. */
  intervalMs: number;
}

export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  sessionTtlHours: number;
  /** Null when the QUICKBOOKS_* env vars aren't fully set — the integration is optional. */
  qbo: QboConfig | null;
  /** 20011: the outbound retry sweep's runtime knobs. See `qbo/retry-sweep.ts` + `index.ts`. */
  syncRetry: SyncRetryConfig;
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

// Deliberately non-throwing, like `loadQboConfig` — an env typo here should degrade to "sweep
// disabled" territory (safe) rather than crash boot. `SYNC_RETRY_ENABLED` follows the codebase's
// existing off-by-explicit-'false' convention (see `positiveInt`'s callers): unset/anything-but-
// the-literal-string-'false' means enabled, since a background sweep is meant to be on by default
// in every real deployment and only explicitly opted out of (e.g. in a test/CI environment that
// still boots the real server for some other check).
function loadSyncRetryConfig(env: NodeJS.ProcessEnv): SyncRetryConfig {
  return {
    enabled: env.SYNC_RETRY_ENABLED !== 'false',
    intervalMs: positiveInt(env, 'SYNC_RETRY_INTERVAL_MS', 60_000),
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
    syncRetry: loadSyncRetryConfig(env),
  });
}

export const config: Config = loadConfig();
