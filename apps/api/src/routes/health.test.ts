import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';

function fakePool(mode: 'ok' | 'fail'): Pool {
  return {
    query: async () => {
      if (mode === 'fail') throw new Error('db down');
      return { rows: [{ ok: 1 }] };
    },
    end: async () => {},
  } as unknown as Pool;
}

describe('GET /health', () => {
  it('returns 200 when the db is reachable', async () => {
    const app = buildApp({ pool: fakePool('ok') });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'up' });
    await app.close();
  });

  it('returns 503 when the db is unreachable', async () => {
    const app = buildApp({ pool: fakePool('fail') });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'down' });
    await app.close();
  });
});
