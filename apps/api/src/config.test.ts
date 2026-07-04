import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('loads a valid environment', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://x', PORT: '3000', NODE_ENV: 'test' });
    expect(cfg).toEqual({ databaseUrl: 'postgres://x', port: 3000, nodeEnv: 'test' });
  });

  it('defaults port and nodeEnv', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(cfg.port).toBe(8080);
    expect(cfg.nodeEnv).toBe('development');
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('throws on a non-positive-integer PORT', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', PORT: '0' })).toThrow(/PORT/);
  });
});
