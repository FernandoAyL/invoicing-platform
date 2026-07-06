import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedBaseOrg, type TestDb } from '../__tests__/helpers/test-db.ts';
import type { QboApiClient, QboEntityEnvelope } from './api-client.ts';
import { upsertConnection } from './connection-service.ts';
import { QboNotConnectedError, QboNotFoundError } from './errors.ts';
import type { QboOAuthClient, QboTokenResult } from './oauth-client.ts';
import { mapNotificationToEntityType, refetchEntity } from './refetch.ts';

const BASE_TOKENS: QboTokenResult = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresIn: 3600,
  refreshTokenExpiresIn: 8726400,
};

function fakeOAuthClient(overrides: Partial<QboOAuthClient> = {}): QboOAuthClient {
  return {
    authorizeUrl: () => 'https://example.test/authorize',
    exchangeCode: async () => BASE_TOKENS,
    refresh: async () => BASE_TOKENS,
    revoke: async () => {},
    ...overrides,
  };
}

function fakeApiClient(overrides: Partial<QboApiClient> = {}): QboApiClient {
  return {
    getEntity: vi.fn(async () => ({ Invoice: { Id: '145' } }) as QboEntityEnvelope),
    createEntity: vi.fn(
      async () => ({ Invoice: { Id: '145', SyncToken: '0' } }) as QboEntityEnvelope,
    ),
    updateEntity: vi.fn(
      async () => ({ Invoice: { Id: '145', SyncToken: '1' } }) as QboEntityEnvelope,
    ),
    voidEntity: vi.fn(
      async () => ({ Invoice: { Id: '145', SyncToken: '1' } }) as QboEntityEnvelope,
    ),
    ...overrides,
  };
}

let testDb: TestDb | undefined;

afterEach(async () => {
  await testDb?.cleanup();
  testDb = undefined;
});

describe('refetchEntity', () => {
  it('resolves token + realm via getValidAccessToken and calls apiClient.getEntity with exactly those', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    await upsertConnection(testDb.db, orgId, { ...BASE_TOKENS, realmId: 'realm-1' });

    const getEntity = vi.fn(async () => ({ Invoice: { Id: '145' } }) as QboEntityEnvelope);
    const apiClient = fakeApiClient({ getEntity });

    const envelope = await refetchEntity(
      { db: testDb.db, oauthClient: fakeOAuthClient(), apiClient },
      { orgId, entityType: 'Invoice', qboId: '145' },
    );

    expect(getEntity).toHaveBeenCalledWith({
      realmId: 'realm-1',
      accessToken: 'access-1',
      entityType: 'Invoice',
      qboId: '145',
    });
    expect(envelope).toEqual({ Invoice: { Id: '145' } });
  });

  it('refreshes a near-expired token and passes the refreshed token to getEntity', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    await upsertConnection(testDb.db, orgId, {
      ...BASE_TOKENS,
      realmId: 'realm-1',
      accessTokenExpiresIn: 0, // already within the 60s skew window
    });

    const refresh = vi.fn(async () => ({
      accessToken: 'access-refreshed',
      refreshToken: 'refresh-refreshed',
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 8726400,
    }));
    const getEntity = vi.fn(async () => ({ Payment: { Id: '9' } }) as QboEntityEnvelope);

    await refetchEntity(
      {
        db: testDb.db,
        oauthClient: fakeOAuthClient({ refresh }),
        apiClient: fakeApiClient({ getEntity }),
      },
      { orgId, entityType: 'Payment', qboId: '9' },
    );

    expect(refresh).toHaveBeenCalledWith('refresh-1');
    expect(getEntity).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'access-refreshed' }),
    );
  });

  it('throws QboNotConnectedError when the org has no connection', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);

    await expect(
      refetchEntity(
        { db: testDb.db, oauthClient: fakeOAuthClient(), apiClient: fakeApiClient() },
        { orgId, entityType: 'Invoice', qboId: '145' },
      ),
    ).rejects.toThrow(QboNotConnectedError);
  });

  it('propagates a typed error from the api client unchanged (e.g. QboNotFoundError)', async () => {
    testDb = await createTestDb();
    const { orgId } = await seedBaseOrg(testDb.db);
    await upsertConnection(testDb.db, orgId, { ...BASE_TOKENS, realmId: 'realm-1' });

    const getEntity = vi.fn(async () => {
      throw new QboNotFoundError('QBO Invoice fetch failed: 404');
    });

    await expect(
      refetchEntity(
        { db: testDb.db, oauthClient: fakeOAuthClient(), apiClient: fakeApiClient({ getEntity }) },
        { orgId, entityType: 'Invoice', qboId: 'missing' },
      ),
    ).rejects.toThrow(QboNotFoundError);
  });
});

describe('mapNotificationToEntityType', () => {
  it('maps known QBO entity names to QboEntityType', () => {
    expect(mapNotificationToEntityType('Invoice')).toBe('Invoice');
    expect(mapNotificationToEntityType('Payment')).toBe('Payment');
    expect(mapNotificationToEntityType('Customer')).toBe('Customer');
    expect(mapNotificationToEntityType('Account')).toBe('Account');
    expect(mapNotificationToEntityType('Item')).toBe('Item');
  });

  it('returns null for an unknown/unsynced entity name', () => {
    expect(mapNotificationToEntityType('Preferences')).toBeNull();
    expect(mapNotificationToEntityType('')).toBeNull();
  });
});
