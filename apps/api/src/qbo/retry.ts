// Pure exponential-backoff calculation for the outbound retry sweep (20011,
// docs/design-decisions.md ## Failure handling). No DB, no timers, no QBO — just a function of
// "how many times has this link failed" -> "how long until the next attempt (or terminal)".

/** After this many failed attempts, a link stops being auto-retried and becomes terminal
 * (`nextRetryAt=null`, stays `state='failed'`, manual-retry-only via `POST
 * /api/sync/failures/:linkId/retry`). */
export const MAX_RETRY_ATTEMPTS = 8;

const BASE_DELAY_MS = 30_000; // 30s
const MAX_DELAY_MS = 60 * 60 * 1000; // 1h cap

/**
 * `retryCount` is the count AFTER the failure that just happened (i.e. the value about to be
 * stamped on the link) — so `computeBackoff(1)` is the delay before the *second* attempt, following
 * the first failure. Exponential: `30s * 2^(retryCount-1)`, capped at 1h. Returns `null` once
 * `retryCount` reaches `MAX_RETRY_ATTEMPTS` — the caller (`markFailed`) interprets `null` as
 * terminal and leaves `nextRetryAt` unset, excluding the link from the auto-sweep.
 */
export function computeBackoff(retryCount: number): number | null {
  if (retryCount < 1) {
    throw new RangeError(`computeBackoff: retryCount must be >= 1, got ${retryCount}`);
  }
  if (retryCount >= MAX_RETRY_ATTEMPTS) return null;
  return Math.min(BASE_DELAY_MS * 2 ** (retryCount - 1), MAX_DELAY_MS);
}
