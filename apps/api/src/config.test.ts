import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const baseEnv = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 'a'.repeat(32) };

describe('loadConfig', () => {
  it('loads a valid environment', () => {
    const cfg = loadConfig({ ...baseEnv, PORT: '3000', NODE_ENV: 'test' });
    expect(cfg).toEqual({
      databaseUrl: 'postgres://x',
      port: 3000,
      nodeEnv: 'test',
      sessionSecret: 'a'.repeat(32),
      sessionTtlHours: 168,
      qbo: null,
      syncRetry: { enabled: true, intervalMs: 60_000 },
    });
  });

  it('defaults port, nodeEnv, and sessionTtlHours', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.port).toBe(8080);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.sessionTtlHours).toBe(168);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ SESSION_SECRET: baseEnv.SESSION_SECRET })).toThrow(/DATABASE_URL/);
  });

  it('throws when SESSION_SECRET is missing', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/SESSION_SECRET/);
  });

  it('throws on a non-positive-integer PORT', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...baseEnv, PORT: '0' })).toThrow(/PORT/);
  });

  it('throws on a non-positive-integer SESSION_TTL_HOURS', () => {
    expect(() => loadConfig({ ...baseEnv, SESSION_TTL_HOURS: 'abc' })).toThrow(/SESSION_TTL_HOURS/);
  });

  it('defaults qbo to null when QUICKBOOKS_* vars are unset', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.qbo).toBeNull();
  });

  it('defaults qbo to null when only some QUICKBOOKS_* vars are set (no throw)', () => {
    const cfg = loadConfig({ ...baseEnv, QUICKBOOKS_CLIENT_ID: 'id-only' });
    expect(cfg.qbo).toBeNull();
  });

  it('loads qbo config when all required vars are set, defaulting environment to sandbox', () => {
    const cfg = loadConfig({
      ...baseEnv,
      QUICKBOOKS_CLIENT_ID: 'client-id',
      QUICKBOOKS_CLIENT_SECRET: 'client-secret',
      QUICKBOOKS_REDIRECT_URI: 'http://localhost:8080/api/integrations/qbo/callback',
    });
    expect(cfg.qbo).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://localhost:8080/api/integrations/qbo/callback',
      environment: 'sandbox',
      webhookVerifierToken: null,
    });
  });

  it('defaults qbo.webhookVerifierToken to null when unset, even with the OAuth trio set', () => {
    const cfg = loadConfig({
      ...baseEnv,
      QUICKBOOKS_CLIENT_ID: 'client-id',
      QUICKBOOKS_CLIENT_SECRET: 'client-secret',
      QUICKBOOKS_REDIRECT_URI: 'http://localhost:8080/api/integrations/qbo/callback',
    });
    expect(cfg.qbo?.webhookVerifierToken).toBeNull();
  });

  it('loads qbo.webhookVerifierToken when QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN is set alongside the OAuth trio', () => {
    const cfg = loadConfig({
      ...baseEnv,
      QUICKBOOKS_CLIENT_ID: 'client-id',
      QUICKBOOKS_CLIENT_SECRET: 'client-secret',
      QUICKBOOKS_REDIRECT_URI: 'http://localhost:8080/api/integrations/qbo/callback',
      QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN: 'verifier-token',
    });
    expect(cfg.qbo?.webhookVerifierToken).toBe('verifier-token');
  });

  it('defaults syncRetry to enabled=true, intervalMs=60000', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.syncRetry).toEqual({ enabled: true, intervalMs: 60_000 });
  });

  it('disables syncRetry only on the literal string "false"', () => {
    expect(loadConfig({ ...baseEnv, SYNC_RETRY_ENABLED: 'false' }).syncRetry.enabled).toBe(false);
    expect(loadConfig({ ...baseEnv, SYNC_RETRY_ENABLED: 'FALSE' }).syncRetry.enabled).toBe(true);
    expect(loadConfig({ ...baseEnv, SYNC_RETRY_ENABLED: '0' }).syncRetry.enabled).toBe(true);
  });

  it('reads a custom SYNC_RETRY_INTERVAL_MS', () => {
    const cfg = loadConfig({ ...baseEnv, SYNC_RETRY_INTERVAL_MS: '5000' });
    expect(cfg.syncRetry.intervalMs).toBe(5000);
  });

  it('throws on a non-positive-integer SYNC_RETRY_INTERVAL_MS', () => {
    expect(() => loadConfig({ ...baseEnv, SYNC_RETRY_INTERVAL_MS: 'abc' })).toThrow(
      /SYNC_RETRY_INTERVAL_MS/,
    );
  });

  it('sets qbo.environment to production when QUICKBOOKS_ENVIRONMENT=production', () => {
    const cfg = loadConfig({
      ...baseEnv,
      QUICKBOOKS_CLIENT_ID: 'client-id',
      QUICKBOOKS_CLIENT_SECRET: 'client-secret',
      QUICKBOOKS_REDIRECT_URI: 'http://localhost:8080/api/integrations/qbo/callback',
      QUICKBOOKS_ENVIRONMENT: 'production',
    });
    expect(cfg.qbo?.environment).toBe('production');
  });
});
