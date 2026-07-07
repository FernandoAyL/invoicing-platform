import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.ts';
import { syncLinks, transactionLines, transactions } from '../db/schema.ts';
import type { QboEntityType } from './api-client.ts';
import { ConflictingLinkError, UnmappableEntityError } from './errors.ts';
import { computeBackoff } from './retry.ts';

type Db = NodePgDatabase<typeof schema>;
// Accepts either the top-level db or the `tx` handle inside `db.transaction(async (tx) => ...)`
// so these finders/writers compose inside a caller's transaction (e.g. `upsertLink`'s own
// select-then-branch, or a future outbound-sync executor wrapping a push + link write together).
type Tx = Parameters<Db['transaction']>[0] extends (tx: infer T, ...args: never[]) => unknown
  ? T
  : never;
type DbOrTx = Db | Tx;

export type SyncLinkRow = typeof syncLinks.$inferSelect;
export type SyncEntityType = SyncLinkRow['entityType'];
export type SyncLinkState = SyncLinkRow['state'];

// `Transaction.type` values that map to a QBO document today. Extended in Phase 4 as more
// transaction types gain QBO document counterparts (vendor_bill -> Bill, etc.).
const TRANSACTION_TYPE_TO_QBO: Partial<Record<string, QboEntityType>> = {
  customer_invoice: 'Invoice',
  payment: 'Payment',
};

/**
 * Pure derivation of the QBO entity name for a local `sync_entity_type`. `transaction` requires
 * `txnType` (the local `Transaction.type`) since one internal table maps to several QBO document
 * types. Throws `UnmappableEntityError` for a transaction type with no QBO document mapping yet,
 * or for `entityType='transaction'` called without a `txnType`.
 */
export function resolveQboType(entityType: SyncEntityType, txnType?: string): QboEntityType {
  if (entityType === 'contact') return 'Customer';
  if (entityType === 'account') return 'Account';
  if (entityType === 'item') return 'Item';

  // entityType === 'transaction'
  if (!txnType) {
    throw new UnmappableEntityError('resolveQboType: transaction entityType requires a txnType');
  }
  const mapped = TRANSACTION_TYPE_TO_QBO[txnType];
  if (!mapped) {
    throw new UnmappableEntityError(
      `resolveQboType: unsupported transaction type for QBO sync: ${txnType}`,
    );
  }
  return mapped;
}

export async function findLinkByLocal(
  db: DbOrTx,
  orgId: string,
  entityType: SyncEntityType,
  localId: string,
): Promise<SyncLinkRow | null> {
  const rows = await db
    .select()
    .from(syncLinks)
    .where(
      and(
        eq(syncLinks.orgId, orgId),
        eq(syncLinks.entityType, entityType),
        eq(syncLinks.localId, localId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findLinkByQbo(
  db: DbOrTx,
  orgId: string,
  qboType: string,
  qboId: string,
): Promise<SyncLinkRow | null> {
  const rows = await db
    .select()
    .from(syncLinks)
    .where(
      and(eq(syncLinks.orgId, orgId), eq(syncLinks.qboType, qboType), eq(syncLinks.qboId, qboId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Loader for the conflict-resolution route (20010): finds a `sync_links` row by its own `id`,
 * org-scoped so a cross-org linkId is invisible (never a 500/leak, the route maps this to 404). */
export async function findLinkById(
  db: DbOrTx,
  orgId: string,
  linkId: string,
): Promise<SyncLinkRow | null> {
  const rows = await db
    .select()
    .from(syncLinks)
    .where(and(eq(syncLinks.orgId, orgId), eq(syncLinks.id, linkId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface UpsertLinkInput {
  orgId: string;
  entityType: SyncEntityType;
  localId: string;
  qboType: string;
  qboId: string;
  state?: SyncLinkState;
  localVersion?: number | null;
  qboSyncToken?: string | null;
  lastSyncedAt?: Date | null;
  /** Undefined (default) leaves the existing value untouched, matching every other optional
   * field here — pass `null` explicitly to clear it (20010: outbound pushes back to `synced`
   * after a conflict resolution do this). */
  conflictDetectedAt?: Date | null;
  /** 20011 retry bookkeeping — same "undefined leaves untouched" convention as every other
   * optional field here. Callers that reach a successful (re)push pass `retryCount: 0,
   * nextRetryAt: null, lastError: null` explicitly to clear any prior failure state (mirroring
   * how `conflictDetectedAt: null` is already passed explicitly on a successful push). */
  retryCount?: number;
  nextRetryAt?: Date | null;
  lastError?: string | null;
}

/**
 * Idempotent link write, respecting both `sync_links` unique constraints
 * (`orgId,entityType,localId` and `orgId,qboType,qboId`). Select-then-branch inside a
 * `db.transaction`, mirroring `connection-service.ts`'s `upsertConnection`:
 *  - no existing row for this local -> insert (after checking the qbo side isn't already
 *    claimed by a different local record).
 *  - existing row for this local with a qboId already assigned, same qbo counterpart -> idempotent
 *    update of state/version/token.
 *  - existing row for this local with a qboId already assigned, different qbo counterpart ->
 *    `ConflictingLinkError` (never silently relinked/overwritten).
 *  - existing row for this local with **no qboId yet** (20011: a `failed` link `markFailed`
 *    seeded before any QBO id existed — first-ever-failure or a not-yet-retried CREATE) -> this is
 *    the FIRST assignment, not a conflict; still guards that the qboId isn't already claimed by a
 *    DIFFERENT local record (the `byQbo` check below), same as the insert path.
 */
export async function upsertLink(db: Db, input: UpsertLinkInput): Promise<SyncLinkRow> {
  return db.transaction(async (tx) => {
    const byLocal = await findLinkByLocal(tx, input.orgId, input.entityType, input.localId);
    if (byLocal) {
      if (byLocal.qboId !== null) {
        if (byLocal.qboType !== input.qboType || byLocal.qboId !== input.qboId) {
          throw new ConflictingLinkError(
            `local ${input.entityType}:${input.localId} is already linked to ${byLocal.qboType}:${byLocal.qboId}, refusing to relink to ${input.qboType}:${input.qboId}`,
          );
        }
      } else {
        const byQbo = await findLinkByQbo(tx, input.orgId, input.qboType, input.qboId);
        if (byQbo && byQbo.id !== byLocal.id) {
          throw new ConflictingLinkError(
            `${input.qboType}:${input.qboId} is already linked to local ${byQbo.entityType}:${byQbo.localId}, refusing to relink to ${input.entityType}:${input.localId}`,
          );
        }
      }

      const [row] = await tx
        .update(syncLinks)
        .set({
          // Always safe to write: when `byLocal.qboId` was already non-null, the guard above
          // already proved `byLocal.qboId === input.qboId` (a no-op write); when it was null,
          // this IS the first-time assignment (20011: linking a previously-`failed`, never-yet-
          // synced row) and must actually persist.
          qboId: input.qboId,
          state: input.state ?? byLocal.state,
          localVersion:
            input.localVersion !== undefined ? input.localVersion : byLocal.localVersion,
          qboSyncToken:
            input.qboSyncToken !== undefined ? input.qboSyncToken : byLocal.qboSyncToken,
          lastSyncedAt:
            input.lastSyncedAt !== undefined ? input.lastSyncedAt : byLocal.lastSyncedAt,
          conflictDetectedAt:
            input.conflictDetectedAt !== undefined
              ? input.conflictDetectedAt
              : byLocal.conflictDetectedAt,
          retryCount: input.retryCount !== undefined ? input.retryCount : byLocal.retryCount,
          nextRetryAt: input.nextRetryAt !== undefined ? input.nextRetryAt : byLocal.nextRetryAt,
          lastError: input.lastError !== undefined ? input.lastError : byLocal.lastError,
          updatedAt: new Date(),
        })
        .where(eq(syncLinks.id, byLocal.id))
        .returning();
      if (!row) throw new Error('failed to update sync link');
      return row;
    }

    const byQbo = await findLinkByQbo(tx, input.orgId, input.qboType, input.qboId);
    if (byQbo) {
      throw new ConflictingLinkError(
        `${input.qboType}:${input.qboId} is already linked to local ${byQbo.entityType}:${byQbo.localId}, refusing to relink to ${input.entityType}:${input.localId}`,
      );
    }

    const [row] = await tx
      .insert(syncLinks)
      .values({
        orgId: input.orgId,
        entityType: input.entityType,
        localId: input.localId,
        qboType: input.qboType,
        qboId: input.qboId,
        state: input.state ?? 'pending',
        localVersion: input.localVersion ?? null,
        qboSyncToken: input.qboSyncToken ?? null,
        lastSyncedAt: input.lastSyncedAt ?? null,
        conflictDetectedAt: input.conflictDetectedAt ?? null,
        retryCount: input.retryCount ?? 0,
        nextRetryAt: input.nextRetryAt ?? null,
        lastError: input.lastError ?? null,
      })
      .returning();
    if (!row) throw new Error('failed to create sync link');
    return row;
  });
}

export async function setLinkState(
  db: DbOrTx,
  orgId: string,
  entityType: SyncEntityType,
  localId: string,
  state: SyncLinkState,
): Promise<SyncLinkRow | null> {
  const rows = await db
    .update(syncLinks)
    .set({ state, updatedAt: new Date() })
    .where(
      and(
        eq(syncLinks.orgId, orgId),
        eq(syncLinks.entityType, entityType),
        eq(syncLinks.localId, localId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export interface MarkSyncedInput {
  qboSyncToken?: string;
  localVersion?: number;
  lastSyncedAt?: Date;
}

/** Flips a link to `synced`, optionally stamping the QBO sync token / local version snapshot
 * that produced this sync and `lastSyncedAt` (defaults to now). Fields not passed are left
 * untouched (not overwritten to null) — only pass what actually changed. `conflictDetectedAt` is
 * the one exception: reaching `synced` always means any prior conflict is over (either it was
 * never in conflict — a no-op clear — or a resolution just re-drove the sync), so it is
 * unconditionally cleared here (20010, decision #2/§0a). Same treatment for the 20011 retry
 * bookkeeping (`retryCount`/`nextRetryAt`/`lastError`): reaching `synced` always means any prior
 * failure is resolved, so all three are unconditionally cleared here too. */
export async function markSynced(
  db: DbOrTx,
  orgId: string,
  entityType: SyncEntityType,
  localId: string,
  input: MarkSyncedInput = {},
): Promise<SyncLinkRow | null> {
  const set: Partial<typeof syncLinks.$inferInsert> = {
    state: 'synced',
    lastSyncedAt: input.lastSyncedAt ?? new Date(),
    conflictDetectedAt: null,
    retryCount: 0,
    nextRetryAt: null,
    lastError: null,
    updatedAt: new Date(),
  };
  if (input.qboSyncToken !== undefined) set.qboSyncToken = input.qboSyncToken;
  if (input.localVersion !== undefined) set.localVersion = input.localVersion;

  const rows = await db
    .update(syncLinks)
    .set(set)
    .where(
      and(
        eq(syncLinks.orgId, orgId),
        eq(syncLinks.entityType, entityType),
        eq(syncLinks.localId, localId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Flips a link to `conflict` and stamps `conflictDetectedAt` (20010, decision #2/§0a) — both-
 * sides-changed detected at the inbound apply seam. Distinct from `setLinkState(...,'conflict')`
 * (which a caller could still reach directly, but shouldn't for this transition) because the
 * timestamp is part of what a conflict transition means: `GET /api/conflicts` and the web UI use
 * it to show "changed in both since <when>", and the conflict-resolution route
 * (`routes/conflicts.ts`, `recoverConflictOperation`) uses it as the lower bound for "which audit
 * rows belong to the CURRENT conflict episode".
 *
 * **Uses the SQL `now()` (transaction timestamp), not a JS `new Date()`.** The audit row for the
 * SAME conflict-raising event (`qbo.inbound.conflict`, written by `audit()` in `inbound-sync.ts`
 * right after this call, in the SAME transaction) is inserted with `syncAuditLogs.createdAt`'s
 * own `defaultNow()` — Postgres's `now()`/`CURRENT_TIMESTAMP` is pinned to transaction START, not
 * per-statement. A JS `new Date()` captured here (mid-transaction, after `now()` was already
 * fixed) would read LATER than that tx-start value, so a caller comparing `audit.createdAt >=
 * conflictDetectedAt` would incorrectly EXCLUDE the very audit row that raised this conflict.
 * Using `sql\`now()\`` here instead makes both timestamps resolve to the same transaction-start
 * value, so they compare equal (and `>=` includes it) regardless of how much wall-clock time
 * elapses between the two statements. */
export async function markConflict(
  db: DbOrTx,
  orgId: string,
  entityType: SyncEntityType,
  localId: string,
): Promise<SyncLinkRow | null> {
  const rows = await db
    .update(syncLinks)
    .set({ state: 'conflict', conflictDetectedAt: sql`now()`, updatedAt: new Date() })
    .where(
      and(
        eq(syncLinks.orgId, orgId),
        eq(syncLinks.entityType, entityType),
        eq(syncLinks.localId, localId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Flips a link to `failed` and stamps 20011 retry bookkeeping — **the failed-item / retry-queue
 * record, including a first-ever failure** (docs/design-decisions.md ## Failure handling,
 * `.claude/plans/20011-failure-handling.md` §0a.1-2). Unlike `setLinkState`, this is an UPSERT:
 * when no link exists yet for this local entity (a brand-new outbound push that never even got a
 * QBO id), one is created here with `qboId=null` so the sweep (`findFailedLinksDue`) can find it —
 * closing the gap where a first-ever push failure previously left no link at all (only an audit
 * row), invisible to any retry loop.
 *
 * `retryCount` increments from whatever was previously stored (0 for a brand-new link), and
 * `computeBackoff` derives `nextRetryAt` from the new count — `null` once the attempt cap is
 * reached, which the sweep/manual-retry-list treats as terminal (still `failed`, no longer
 * auto-retried).
 *
 * **Never demotes a `conflict` link.** A conflict is a user decision owned by 20010, not a
 * transient failure — if the existing link is already `conflict`, this is a no-op that returns
 * the row unchanged (mirrors the `force`-push guard in `outbound-sync.ts`'s `failOutbound`, which
 * routes a force-push failure to `markConflict` instead of ever calling this function on a
 * conflict link — this guard is a second, defense-in-depth layer for any other caller).
 */
export async function markFailed(
  db: Db,
  orgId: string,
  entityType: SyncEntityType,
  localId: string,
  qboType: string,
  errorMessage: string,
): Promise<SyncLinkRow | null> {
  return db.transaction(async (tx) => {
    const existing = await findLinkByLocal(tx, orgId, entityType, localId);
    if (existing?.state === 'conflict') {
      return existing;
    }

    const retryCount = (existing?.retryCount ?? 0) + 1;
    const backoffMs = computeBackoff(retryCount);
    const nextRetryAt = backoffMs === null ? null : new Date(Date.now() + backoffMs);

    if (existing) {
      const [row] = await tx
        .update(syncLinks)
        .set({
          state: 'failed',
          retryCount,
          nextRetryAt,
          lastError: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(syncLinks.id, existing.id))
        .returning();
      return row ?? null;
    }

    const [row] = await tx
      .insert(syncLinks)
      .values({
        orgId,
        entityType,
        localId,
        qboType,
        qboId: null,
        state: 'failed',
        retryCount,
        nextRetryAt,
        lastError: errorMessage,
      })
      .returning();
    return row ?? null;
  });
}

/** Cross-org: every `failed` link whose backoff has elapsed (`nextRetryAt` set and `<= now`).
 * Used only by the background sweep (`runOutboundRetrySweep`) — a terminal link (`nextRetryAt`
 * null, attempt cap reached) is correctly excluded, and so is a `conflict` link (different
 * state entirely). */
export async function findFailedLinksDue(db: DbOrTx, now: Date): Promise<SyncLinkRow[]> {
  return db
    .select()
    .from(syncLinks)
    .where(
      and(
        eq(syncLinks.state, 'failed'),
        isNotNull(syncLinks.nextRetryAt),
        lte(syncLinks.nextRetryAt, now),
      ),
    );
}

/** Org-scoped list of every `failed` link (due or terminal alike) — backs `GET
 * /api/sync/failures`. Unlike `findFailedLinksDue`, this includes terminal (nextRetryAt=null)
 * links too, since those are still visible for manual retry. */
export async function findFailedLinksForOrg(db: DbOrTx, orgId: string): Promise<SyncLinkRow[]> {
  return db
    .select()
    .from(syncLinks)
    .where(and(eq(syncLinks.orgId, orgId), eq(syncLinks.state, 'failed')));
}

export interface DepRef {
  entityType: SyncEntityType;
  localId: string;
}

export interface DepStatus extends DepRef {
  link: SyncLinkRow | null;
}

export interface TransactionDeps {
  /** null when the transaction has no `contactId` (e.g. a pure journal entry). */
  contact: DepStatus | null;
  accounts: DepStatus[];
  items: DepStatus[];
  /** true when every referenced entity (contact + line accounts + line items) has a link. */
  allLinked: boolean;
  unlinked: DepRef[];
}

/**
 * Reference-data-first dependency **report** for a transaction: which of its referenced entities
 * (its contact, the distinct accounts its lines post to, the distinct items its lines use) are
 * already linked vs still need linking. Read-only — does not push anything to QBO or mutate any
 * link (that's 20006's job); this just tells the caller what must be linked first.
 */
export async function resolveTransactionDeps(
  db: DbOrTx,
  orgId: string,
  txnId: string,
): Promise<TransactionDeps> {
  const [txn] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.orgId, orgId), eq(transactions.id, txnId)))
    .limit(1);
  if (!txn) throw new Error(`resolveTransactionDeps: transaction not found: ${txnId}`);

  const lines = await db
    .select()
    .from(transactionLines)
    .where(and(eq(transactionLines.orgId, orgId), eq(transactionLines.transactionId, txnId)));

  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const itemIds = [
    ...new Set(lines.map((line) => line.itemId).filter((id): id is string => id !== null)),
  ];

  const contact: DepStatus | null = txn.contactId
    ? {
        entityType: 'contact',
        localId: txn.contactId,
        link: await findLinkByLocal(db, orgId, 'contact', txn.contactId),
      }
    : null;

  const accounts: DepStatus[] = await Promise.all(
    accountIds.map(async (id) => ({
      entityType: 'account' as const,
      localId: id,
      link: await findLinkByLocal(db, orgId, 'account', id),
    })),
  );

  const items: DepStatus[] = await Promise.all(
    itemIds.map(async (id) => ({
      entityType: 'item' as const,
      localId: id,
      link: await findLinkByLocal(db, orgId, 'item', id),
    })),
  );

  const unlinked: DepRef[] = [];
  if (contact && !contact.link)
    unlinked.push({ entityType: contact.entityType, localId: contact.localId });
  for (const status of accounts) {
    if (!status.link) unlinked.push({ entityType: status.entityType, localId: status.localId });
  }
  for (const status of items) {
    if (!status.link) unlinked.push({ entityType: status.entityType, localId: status.localId });
  }

  return { contact, accounts, items, allLinked: unlinked.length === 0, unlinked };
}
