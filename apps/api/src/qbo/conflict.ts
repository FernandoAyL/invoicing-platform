// Pure both-sides-changed conflict detector (see `.claude/plans/20010-conflict-detection.md`
// §0a.1 / `docs/design-decisions.md` ## Conflict resolution). Answers the question the ordering
// guard (`qbo/ordering.ts`) deliberately leaves open: given that the incoming QBO change is NOT
// stale (i.e. QBO genuinely changed since the last successful sync), did the LOCAL record also
// change since that same last sync? If both sides moved, this is a conflict — neither side's
// edit should silently clobber the other (last-write-wins is explicitly rejected for financial
// records).

export interface LocalVersionState {
  /** The `sync_links.localVersion` snapshot recorded at the last successful sync — the local
   * `transactions.version` this link last confirmed was pushed/pulled. `null` means the link has
   * never recorded a local version (e.g. a brand-new link from natural-key matching) — treated as
   * NOT dirty so a first-ever sync never false-flags as a conflict. */
  storedLocalVersion: number | null;
  /** The local record's CURRENT `transactions.version`. */
  txnVersion: number;
}

/**
 * `true` iff local is dirty (`txnVersion > storedLocalVersion`, with a non-null
 * `storedLocalVersion` — see the field doc above) AND the incoming QBO change is genuinely newer
 * (`incomingIsStale === false`, i.e. `isStaleInboundApply` from `qbo/ordering.ts` returned
 * false for this same event). Callers only reach this check after the stale early-return, so
 * `incomingIsStale` is always `false` in production call sites — it's kept as an explicit input
 * (rather than assumed) purely for this function's own testability/clarity, per the locked
 * decision.
 */
export function isBothSidesConflict(local: LocalVersionState, incomingIsStale: boolean): boolean {
  if (incomingIsStale) return false;
  if (local.storedLocalVersion === null) return false;
  return local.txnVersion > local.storedLocalVersion;
}

/**
 * 30015: a second, distinct kind of conflict raised by the inbound invoice line/amount re-sync
 * (`qbo/inbound-sync.ts`'s `applyInvoiceLineResync`) — not a both-sides-changed version race, but
 * a QBO-side total edit that would drop the invoice below what's already been applied as payment
 * locally. Per the design call: each individual edit (the QBO edit, the local payments) is
 * independently balanced, so there's no ledger-integrity risk in applying either alone — the risk
 * is only in silently forcing a new total that contradicts money the business has already
 * recorded as received. Surfaced as a `conflict` for a human to resolve, same as any other
 * both-sides case, rather than force-applied or silently dropped.
 */
export function wouldUnderflowPaidAmount(totalCents: number, paidCents: number): boolean {
  return totalCents < paidCents;
}
