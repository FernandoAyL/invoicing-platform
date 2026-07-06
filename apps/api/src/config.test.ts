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
    });
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
