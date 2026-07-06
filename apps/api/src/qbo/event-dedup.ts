import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.ts';
import { processedEvents } from '../db/schema.ts';

type Db = NodePgDatabase<typeof schema>;
// Accepts either the top-level db or the `tx` handle inside `db.transaction(async (tx) => ...)`,
// same pattern as sync-link-service.ts / audit/service.ts.
type Tx = Parameters<Db['transaction']>[0] extends (tx: infer T, ...args: never[]) => unknown
  ? T
  : never;
type DbOrTx = Db | Tx;

export interface WebhookEventIdentity {
  realmId: string;
  name: string;
  id: string;
  operation: string;
  /** QBO's per-change timestamp. When present it's part of the key (a genuine re-edit gets a new
   * `lastUpdated` and is therefore a new event, not a dup). When absent, the key falls back to the
   * 4-tuple — a same-operation redelivery without `lastUpdated` is then treated as a duplicate;
   * this tradeoff is intentional (see 20005 plan, edge cases). */
  lastUpdated?: string;
}

/**
 * Pure, deterministic derivation of the inbound event idempotency key. Identical inputs always
 * produce the identical string — this is what `recordEventIfNew` records and what tests assert
 * distinctness/stability against.
 */
export function buildEventKey(identity: WebhookEventIdentity): string {
  const { realmId, name, id, operation, lastUpdated } = identity;
  return lastUpdated
    ? `${realmId}:${name}:${id}:${operation}:${lastUpdated}`
    : `${realmId}:${name}:${id}:${operation}`;
}

export interface RecordEventInput extends WebhookEventIdentity {
  orgId: string;
}

/**
 * Atomic check-and-record for inbound webhook dedup: `INSERT ... ON CONFLICT (org_id, event_key)
 * DO NOTHING RETURNING id`. Returns `true` when this call performed the insert (first delivery —
 * caller should process/apply the event), `false` when the unique constraint swallowed it (a
 * redelivery — caller should skip). The whole check-and-record is one statement, so two
 * concurrent deliveries of the same event can never both "win" (no separate SELECT-then-INSERT
 * race).
 */
export async function recordEventIfNew(db: DbOrTx, input: RecordEventInput): Promise<boolean> {
  const eventKey = buildEventKey(input);
  const rows = await db
    .insert(processedEvents)
    .values({
      orgId: input.orgId,
      eventKey,
      realmId: input.realmId,
      entityName: input.name,
      entityId: input.id,
      operation: input.operation,
    })
    .onConflictDoNothing({ target: [processedEvents.orgId, processedEvents.eventKey] })
    .returning({ id: processedEvents.id });
  return rows.length > 0;
}
