// `config.qbo` and `config.qboTokenEncryptionKey` are module-level singletons read once at import
// time (apps/api/src/config.ts), so — like routes/internal.test.ts — these tests reset the module
// registry and re-import with env vars set, rather than relying on buildApp()'s injection points
// (which would bypass the config-driven `qboReady` gate entirely).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../__tests__/helpers/test-db.ts';

const QBO_TRIO_ENV = {
  QUICKBOOKS_CLIENT_ID: 'client-id',
  QUICKBOOKS_CLIENT_SECRET: 'client-secret',
  QUICKBOOKS_REDIRECT_URI: 'http://localhost:8080/api/integrations/qbo/callback',
};

describe('qbo plugin — qboReady gate (30020)', () => {
  let testDb: TestDb;
  const mutatedKeys = [...Object.keys(QBO_TRIO_ENV), 'QBO_TOKEN_ENCRYPTION_KEY'];
  const originalEnv = Object.fromEntries(mutatedKeys.map((key) => [key, process.env[key]]));

  beforeEach(async () => {
    vi.resetModules();
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.cleanup();
    for (const key of mutatedKeys) {
      const original = originalEnv[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('QBO trio set but encryption key missing: qboOAuthClient/qboApiClient stay null (fail closed)', async () => {
    Object.assign(process.env, QBO_TRIO_ENV);
    delete process.env.QBO_TOKEN_ENCRYPTION_KEY;

    const { buildApp } = await import('../app.ts');
    const app = buildApp({ db: testDb.db });
    await app.ready();

    expect(app.qboOAuthClient).toBeNull();
    expect(app.qboApiClient).toBeNull();
    await app.close();
  });

  it('QBO trio set and encryption key set: qboOAuthClient/qboApiClient are constructed', async () => {
    Object.assign(process.env, QBO_TRIO_ENV);
    process.env.QBO_TOKEN_ENCRYPTION_KEY = 'a-32-character-test-encryption-key';

    const { buildApp } = await import('../app.ts');
    const app = buildApp({ db: testDb.db });
    await app.ready();

    expect(app.qboOAuthClient).not.toBeNull();
    expect(app.qboApiClient).not.toBeNull();
    await app.close();
  });

  it('encryption key set but QBO trio missing: qboOAuthClient/qboApiClient stay null', async () => {
    process.env.QBO_TOKEN_ENCRYPTION_KEY = 'a-32-character-test-encryption-key';

    const { buildApp } = await import('../app.ts');
    const app = buildApp({ db: testDb.db });
    await app.ready();

    expect(app.qboOAuthClient).toBeNull();
    expect(app.qboApiClient).toBeNull();
    await app.close();
  });
});
