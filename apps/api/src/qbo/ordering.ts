// Pure ordering guard for inbound QBO applies (see `.claude/plans/20008-ordering.md` §0a /
// `docs/design-decisions.md` ## Ordering). Answers one question — "is this incoming change
// older than (or the same as) what we already recorded as applied?" — so `inbound-sync.ts` can
// skip a stale/duplicate webhook instead of clobbering newer state with older data.
//
// Primary comparator: QBO's `SyncToken`, a per-entity monotonically increasing integer (sent as
// a string). Apply iff `incoming > stored`; equal or lower is stale (already applied / older).
// Fallback: when a SyncToken is missing on either side, compare `MetaData.LastUpdatedTime`
// (incoming) against the locally recorded `lastSyncedAt` (stored) instead. First-ever apply (no
// recorded token AND no recorded timestamp) is never stale — there is nothing to be older than.
// This is one-sided staleness only; both-sides-changed conflict detection is 20010.

export interface StoredSyncState {
  storedSyncToken?: string | null;
  storedLastSyncedAt?: Date | null;
}

export interface IncomingSyncState {
  incomingSyncToken?: string | null;
  incomingLastUpdated?: string | null;
}

/** Parses a QBO `SyncToken` string to an int, or `null` for missing/non-numeric garbage. Never
 * throws — a bad token just falls through to the timestamp fallback. */
export function parseSyncToken(token?: string | null): number | null {
  if (token === undefined || token === null || token.trim() === '') return null;
  const parsed = Number(token);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIsoDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `true` when the incoming QBO state is NOT newer than what's already recorded, i.e. the apply
 * should be skipped. Never throws.
 *
 * - Both sides have a parseable SyncToken -> compare as ints; apply iff `incoming > stored`
 *   (equal counts as stale — idempotent re-apply of the same version is a no-op).
 * - Either side's SyncToken is missing/non-numeric -> fall back to `incomingLastUpdated` vs
 *   `storedLastSyncedAt`. No recorded timestamp at all (first sync) -> not stale, always apply.
 *   A recorded timestamp but no incoming one (can't order it) -> conservatively not stale, apply
 *   rather than silently drop a real change.
 */
export function isStaleInboundApply(stored: StoredSyncState, incoming: IncomingSyncState): boolean {
  const storedToken = parseSyncToken(stored.storedSyncToken);
  const incomingToken = parseSyncToken(incoming.incomingSyncToken);

  if (storedToken !== null && incomingToken !== null) {
    return incomingToken <= storedToken;
  }

  const storedAt = stored.storedLastSyncedAt ?? null;
  if (storedAt === null) {
    // Nothing recorded to compare against at all (no usable token, no timestamp) -> first sync.
    return false;
  }

  const incomingAt = parseIsoDate(incoming.incomingLastUpdated);
  if (incomingAt === null) {
    // We have a recorded timestamp but nothing to order the incoming change against -> don't
    // silently drop a real change.
    return false;
  }

  return incomingAt.getTime() <= storedAt.getTime();
}
