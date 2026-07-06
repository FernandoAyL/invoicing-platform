import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.ts';
import { qboConnections } from '../db/schema.ts';
import { QboNotConnectedError } from './errors.ts';
import type { QboOAuthClient, QboTokenResult } from './oauth-client.ts';

type Db = NodePgDatabase<typeof schema>;

export interface QboConnection {
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

export interface QboConnectionStatus {
  connected: boolean;
  realmId: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

export interface UpsertConnectionInput extends QboTokenResult {
  realmId: string;
}

// Treat a token as expiring 60s early so a request in flight doesn't get a token that dies
// mid-call.
const ACCESS_TOKEN_SKEW_MS = 60_000;

function expiryDate(expiresInSeconds: number): Date {
  return new Date(Date.now() + expiresInSeconds * 1000);
}

export async function getConnection(db: Db, orgId: string): Promise<QboConnection | null> {
  const rows = await db
    .select()
    .from(qboConnections)
    .where(eq(qboConnections.orgId, orgId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolves a connection by `realmId` — the direction an inbound webhook needs (Intuit gives us
 * the realm, not the org). `realmId` has no unique constraint, but is effectively one-per-connection
 * in practice; returns the first match.
 */
export async function getConnectionByRealmId(
  db: Db,
  realmId: string,
): Promise<QboConnection | null> {
  const rows = await db
    .select()
    .from(qboConnections)
    .where(eq(qboConnections.realmId, realmId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Upsert on the existing `unique(org_id)` constraint — one connection per org, reconnecting
 * re-homes tokens rather than creating a duplicate row. Implemented as select-then-branch inside
 * a transaction (rather than `ON CONFLICT`) to match this codebase's existing service style
 * (see `contacts/service.ts`), which keeps it exercisable by the same hand-rolled fake-db test
 * harness used by every other route/service test.
 */
export async function upsertConnection(
  db: Db,
  orgId: string,
  input: UpsertConnectionInput,
): Promise<QboConnection> {
  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(qboConnections)
      .where(eq(qboConnections.orgId, orgId))
      .limit(1);

    const values = {
      orgId,
      realmId: input.realmId,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      accessTokenExpiresAt: expiryDate(input.accessTokenExpiresIn),
      refreshTokenExpiresAt: expiryDate(input.refreshTokenExpiresIn),
      updatedAt: new Date(),
    };

    if (existingRows[0]) {
      const [row] = await tx
        .update(qboConnections)
        .set(values)
        .where(eq(qboConnections.orgId, orgId))
        .returning();
      if (!row) throw new Error('failed to update qbo connection');
      return row;
    }

    const [row] = await tx.insert(qboConnections).values(values).returning();
    if (!row) throw new Error('failed to create qbo connection');
    return row;
  });
}

export async function deleteConnection(db: Db, orgId: string): Promise<boolean> {
  const rows = await db
    .delete(qboConnections)
    .where(eq(qboConnections.orgId, orgId))
    .returning({ id: qboConnections.id });
  return rows.length > 0;
}

export async function connectionStatus(db: Db, orgId: string): Promise<QboConnectionStatus> {
  const connection = await getConnection(db, orgId);
  if (!connection) {
    return {
      connected: false,
      realmId: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    };
  }
  return {
    connected: true,
    realmId: connection.realmId,
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
  };
}

/**
 * The reusable primitive every later QBO sync task calls before an API request: returns a
 * definitely-fresh access token, refreshing and persisting it first if it's null or within 60s
 * of expiry. Throws `QboNotConnectedError` when there's no connection row, or when the refresh
 * itself fails (e.g. the refresh token was revoked/expired on Intuit's side) — callers should
 * surface "reconnect required" rather than retry, and no half-updated row is left behind.
 */
export async function getValidAccessToken(
  db: Db,
  client: QboOAuthClient,
  orgId: string,
): Promise<{ accessToken: string; realmId: string }> {
  const connection = await getConnection(db, orgId);
  if (!connection) {
    throw new QboNotConnectedError(`No QBO connection for org ${orgId}`);
  }

  const expiresAt = connection.accessTokenExpiresAt;
  const isFresh = expiresAt !== null && expiresAt.getTime() - ACCESS_TOKEN_SKEW_MS > Date.now();
  if (isFresh) {
    return { accessToken: connection.accessToken, realmId: connection.realmId };
  }

  let tokens: QboTokenResult;
  try {
    tokens = await client.refresh(connection.refreshToken);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new QboNotConnectedError(`QBO token refresh failed for org ${orgId}: ${reason}`);
  }

  const updated = await upsertConnection(db, orgId, { ...tokens, realmId: connection.realmId });
  return { accessToken: updated.accessToken, realmId: updated.realmId };
}
