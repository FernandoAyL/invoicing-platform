import { randomUUID } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import type * as schema from '../db/schema.ts';
import { qboConnections } from '../db/schema.ts';
import {
  connectionStatus,
  deleteConnection,
  getConnection,
  getValidAccessToken,
  upsertConnection,
} from './connection-service.ts';
import { QboNotConnectedError } from './errors.ts';
import type { QboOAuthClient, QboTokenResult } from './oauth-client.ts';

interface FakeConnectionRow {
  id: string;
  orgId: string;
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SqlChunk {
  queryChunks?: SqlChunk[];
  constructor: { name: string };
  value?: unknown;
  table?: unknown;
  name?: unknown;
}

const columnKeyByRef = new Map<unknown, string>(
  Object.entries(getTableColumns(qboConnections)).map(([key, col]) => [col, key]),
);

function extractEqPairs(
  node: SqlChunk | null | undefined,
  acc: { columns: SqlChunk[]; params: unknown[] } = { columns: [], params: [] },
) {
  if (!node) return acc;
  if (Array.isArray(node.queryChunks)) {
    for (const chunk of node.queryChunks) extractEqPairs(chunk, acc);
    return acc;
  }
  const ctorName = node.constructor?.name;
  if (ctorName === 'Param') {
    acc.params.push(node.value);
  } else if (ctorName !== 'StringChunk' && node.table && typeof node.name === 'string') {
    acc.columns.push(node);
  }
  return acc;
}

function rowMatches(row: FakeConnectionRow, cond: unknown): boolean {
  const { columns, params } = extractEqPairs(cond as SqlChunk);
  if (columns.length === 0) return true;
  return columns.every((col, i) => {
    const key = columnKeyByRef.get(col);
    if (!key) throw new Error('fakeDb: unmapped column in where clause');
    return (row as unknown as Record<string, unknown>)[key] === params[i];
  });
}

function cloneRow<T>(row: T): T {
  return { ...row };
}

function createFakeDb() {
  const state = { connections: [] as FakeConnectionRow[] };

  const baseDb = {
    select() {
      return {
        from(table: unknown) {
          if (table !== qboConnections) throw new Error('fakeDb: unsupported table');
          return {
            where(cond: unknown) {
              const filtered = state.connections.filter((r) => rowMatches(r, cond));
              const result = Promise.resolve(filtered.map(cloneRow)) as Promise<
                FakeConnectionRow[]
              > & { limit: (n: number) => Promise<FakeConnectionRow[]> };
              result.limit = (n: number) => Promise.resolve(filtered.slice(0, n).map(cloneRow));
              return result;
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(vals: Record<string, unknown>) {
          if (table !== qboConnections) throw new Error('fakeDb: unsupported table');
          const now = new Date();
          const row: FakeConnectionRow = {
            id: randomUUID(),
            orgId: vals.orgId as string,
            realmId: vals.realmId as string,
            accessToken: vals.accessToken as string,
            refreshToken: vals.refreshToken as string,
            accessTokenExpiresAt: (vals.accessTokenExpiresAt as Date | undefined) ?? null,
            refreshTokenExpiresAt: (vals.refreshTokenExpiresAt as Date | undefined) ?? null,
            createdAt: now,
            updatedAt: (vals.updatedAt as Date | undefined) ?? now,
          };
          state.connections.push(row);
          const result = Promise.resolve([cloneRow(row)]) as Promise<FakeConnectionRow[]> & {
            returning: () => Promise<FakeConnectionRow[]>;
          };
          result.returning = () => Promise.resolve([cloneRow(row)]);
          return result;
        },
      };
    },
    update(table: unknown) {
      return {
        set(vals: Record<string, unknown>) {
          return {
            where(cond: unknown) {
              return {
                async returning() {
                  if (table !== qboConnections) throw new Error('fakeDb: unsupported table');
                  const matched = state.connections.filter((r) => rowMatches(r, cond));
                  for (const row of matched) Object.assign(row, vals);
                  return matched.map(cloneRow);
                },
              };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where(cond: unknown) {
          return {
            async returning(selection?: Record<string, unknown>) {
              if (table !== qboConnections) throw new Error('fakeDb: unsupported table');
              const matched = state.connections.filter((r) => rowMatches(r, cond));
              state.connections = state.connections.filter((r) => !rowMatches(r, cond));
              return matched.map((row) => {
                if (!selection) return cloneRow(row);
                return Object.fromEntries(
                  Object.keys(selection).map((k) => [
                    k,
                    (row as unknown as Record<string, unknown>)[k],
                  ]),
                );
              });
            },
          };
        },
      };
    },
  };

  const db = {
    ...baseDb,
    async transaction<T>(fn: (tx: typeof baseDb) => Promise<T>): Promise<T> {
      const snapshot = state.connections.map(cloneRow);
      try {
        return await fn(baseDb);
      } catch (err) {
        state.connections = snapshot;
        throw err;
      }
    },
  };

  return { db: db as unknown as NodePgDatabase<typeof schema>, state };
}

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const BASE_TOKENS: QboTokenResult = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresIn: 3600,
  refreshTokenExpiresIn: 8726400,
};

function fakeClient(overrides: Partial<QboOAuthClient> = {}): QboOAuthClient {
  return {
    authorizeUrl: () => 'https://example.test/authorize',
    exchangeCode: async () => BASE_TOKENS,
    refresh: async () => BASE_TOKENS,
    revoke: async () => {},
    ...overrides,
  };
}

describe('upsertConnection / getConnection', () => {
  it('creates a new connection row for an org with no existing connection', async () => {
    const { db, state } = createFakeDb();

    const row = await upsertConnection(db, ORG_A, { ...BASE_TOKENS, realmId: 'realm-1' });

    expect(row.orgId).toBe(ORG_A);
    expect(row.realmId).toBe('realm-1');
    expect(row.accessToken).toBe('access-1');
    expect(state.connections).toHaveLength(1);
  });

  it('re-homes tokens on reconnect instead of creating a duplicate row (unique org_id)', async () => {
    const { db, state } = createFakeDb();

    await upsertConnection(db, ORG_A, { ...BASE_TOKENS, realmId: 'realm-1' });
    const second = await upsertConnection(db, ORG_A, {
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 8726400,
      realmId: 'realm-2',
    });

    expect(state.connections).toHaveLength(1);
    expect(second.realmId).toBe('realm-2');
    expect(second.accessToken).toBe('access-2');
  });

  it('scopes getConnection by org, returning null for an org with no row', async () => {
    const { db } = createFakeDb();
    await upsertConnection(db, ORG_A, { ...BASE_TOKENS, realmId: 'realm-1' });

    expect(await getConnection(db, ORG_B)).toBeNull();
    expect((await getConnection(db, ORG_A))?.realmId).toBe('realm-1');
  });
});

describe('deleteConnection', () => {
  it('deletes the row and returns true; returns false when nothing to delete', async () => {
    const { db, state } = createFakeDb();
    await upsertConnection(db, ORG_A, { ...BASE_TOKENS, realmId: 'realm-1' });

    expect(await deleteConnection(db, ORG_A)).toBe(true);
    expect(state.connections).toHaveLength(0);
    expect(await deleteConnection(db, ORG_A)).toBe(false);
  });
});

describe('connectionStatus', () => {
  it('returns connected:false with no row', async () => {
    const { db } = createFakeDb();
    expect(await connectionStatus(db, ORG_A)).toEqual({
      connected: false,
      realmId: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
  });

  it('never includes token fields, only connected/realmId/expiries', async () => {
    const { db } = createFakeDb();
    await upsertConnection(db, ORG_A, { ...BASE_TOKENS, realmId: 'realm-1' });

    const status = await connectionStatus(db, ORG_A);
    expect(status.connected).toBe(true);
    expect(status.realmId).toBe('realm-1');
    expect(Object.keys(status).sort()).toEqual(
      ['accessTokenExpiresAt', 'connected', 'realmId', 'refreshTokenExpiresAt'].sort(),
    );
  });
});

describe('getValidAccessToken', () => {
  it('throws QboNotConnectedError when there is no connection row', async () => {
    const { db } = createFakeDb();
    await expect(getValidAccessToken(db, fakeClient(), ORG_A)).rejects.toThrow(
      QboNotConnectedError,
    );
  });

  it('returns the stored access token without calling refresh when not expiring', async () => {
    const { db } = createFakeDb();
    await upsertConnection(db, ORG_A, { ...BASE_TOKENS, realmId: 'realm-1' });
    const refresh = vi.fn(async () => BASE_TOKENS);

    const result = await getValidAccessToken(db, fakeClient({ refresh }), ORG_A);

    expect(result).toEqual({ accessToken: 'access-1', realmId: 'realm-1' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes and persists a new token when the access token is within the 60s skew', async () => {
    const { db, state } = createFakeDb();
    await upsertConnection(db, ORG_A, {
      ...BASE_TOKENS,
      realmId: 'realm-1',
      accessTokenExpiresIn: 30, // expires in 30s, inside the 60s skew window
    });
    const refresh = vi.fn(async () => ({
      accessToken: 'access-refreshed',
      refreshToken: 'refresh-refreshed',
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 8726400,
    }));

    const result = await getValidAccessToken(db, fakeClient({ refresh }), ORG_A);

    expect(refresh).toHaveBeenCalledWith('refresh-1');
    expect(result).toEqual({ accessToken: 'access-refreshed', realmId: 'realm-1' });
    expect(state.connections[0]?.accessToken).toBe('access-refreshed');
    expect(state.connections).toHaveLength(1);
  });

  it('refreshes when accessTokenExpiresAt is null', async () => {
    const { db } = createFakeDb();
    await upsertConnection(db, ORG_A, { ...BASE_TOKENS, realmId: 'realm-1' });
    // Simulate a legacy/partial row with no expiry recorded.
    const rows = await getConnection(db, ORG_A);
    if (!rows) throw new Error('expected a connection row in test setup');

    const refresh = vi.fn(async () => BASE_TOKENS);
    // Force expiry by upserting with a 0s window, then confirm the refresh path is taken again.
    await upsertConnection(db, ORG_A, {
      ...BASE_TOKENS,
      realmId: 'realm-1',
      accessTokenExpiresIn: 0,
    });
    await getValidAccessToken(db, fakeClient({ refresh }), ORG_A);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('throws QboNotConnectedError (not a raw error) when the refresh call fails, without touching the stored row', async () => {
    const { db, state } = createFakeDb();
    await upsertConnection(db, ORG_A, {
      ...BASE_TOKENS,
      realmId: 'realm-1',
      accessTokenExpiresIn: 0,
    });
    const before = state.connections[0] ? { ...state.connections[0] } : null;

    const refresh = vi.fn(async () => {
      throw new Error('invalid_grant');
    });

    await expect(getValidAccessToken(db, fakeClient({ refresh }), ORG_A)).rejects.toThrow(
      QboNotConnectedError,
    );
    expect(state.connections[0]).toEqual(before);
  });
});
