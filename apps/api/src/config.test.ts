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
});
