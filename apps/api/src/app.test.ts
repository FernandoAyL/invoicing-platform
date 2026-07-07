import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './__tests__/helpers/test-db.ts';
import { buildApp } from './app.ts';

let testDb: TestDb | undefined;

afterEach(async () => {
  await testDb?.cleanup();
  testDb = undefined;
});

describe('buildApp starts no timers (20011 §0a.7)', () => {
  it('app.ts never calls setInterval — the outbound retry sweep is wired only in index.ts', () => {
    const appTsPath = fileURLToPath(new URL('./app.ts', import.meta.url));
    const source = readFileSync(appTsPath, 'utf8');
    expect(source).not.toMatch(/setInterval/);
  });

  it('constructing and readying the app spawns zero setInterval calls', async () => {
    testDb = await createTestDb();

    const originalSetInterval = global.setInterval;
    let intervalsStarted = 0;
    // @ts-expect-error -- intentional test-only monkeypatch to observe timer creation
    global.setInterval = (...args: Parameters<typeof setInterval>) => {
      intervalsStarted += 1;
      return originalSetInterval(...args);
    };

    let app: ReturnType<typeof buildApp> | undefined;
    try {
      app = buildApp({ db: testDb.db, qboOAuthClient: null, qboApiClient: null });
      await app.ready();
    } finally {
      global.setInterval = originalSetInterval;
    }

    expect(intervalsStarted).toBe(0);
    await app.close();
  });
});
