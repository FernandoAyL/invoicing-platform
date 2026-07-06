import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.ts';
import type { QboApiClient, QboEntityEnvelope, QboEntityType } from './api-client.ts';
import { getValidAccessToken } from './connection-service.ts';
import type { QboOAuthClient } from './oauth-client.ts';

type Db = NodePgDatabase<typeof schema>;

export interface RefetchEntityDeps {
  db: Db;
  oauthClient: QboOAuthClient;
  apiClient: QboApiClient;
}

export interface RefetchEntityArgs {
  orgId: string;
  entityType: QboEntityType;
  qboId: string;
}

/**
 * QBO webhook notifications only carry `{ name, id, operation }` — never the full record — so
 * inbound sync (20007) always refetches the authoritative full state before applying. Resolves a
 * fresh access token + realmId (refreshing on-demand via `getValidAccessToken`) and reads the
 * entity. Propagates `QboNotConnectedError` (no connection) and the api-client's typed errors
 * unchanged — callers decide how to react.
 */
export async function refetchEntity(
  deps: RefetchEntityDeps,
  args: RefetchEntityArgs,
): Promise<QboEntityEnvelope> {
  const { accessToken, realmId } = await getValidAccessToken(deps.db, deps.oauthClient, args.orgId);
  return deps.apiClient.getEntity({
    realmId,
    accessToken,
    entityType: args.entityType,
    qboId: args.qboId,
  });
}

const NOTIFICATION_ENTITY_TYPES: ReadonlySet<QboEntityType> = new Set([
  'Invoice',
  'Payment',
  'Customer',
  'Account',
  'Item',
]);

/** Maps a QBO webhook notification's entity `name` (e.g. `Invoice`) to our `QboEntityType`.
 * Unknown/unsynced entity names (e.g. `Preferences`) return null so 20007 can skip them. */
export function mapNotificationToEntityType(qboName: string): QboEntityType | null {
  return NOTIFICATION_ENTITY_TYPES.has(qboName as QboEntityType)
    ? (qboName as QboEntityType)
    : null;
}
