// Pure natural-key matchers for linking pre-existing records (both systems already hold "the
// same" customer/invoice, but no `sync_links` row exists yet). No QBO fetching happens here —
// candidates are passed in by the caller (the QBO query API is out of scope for this task,
// deferred to inbound/reconciliation). Never mutates, never guesses past an unambiguous match:
// anything that isn't a single confident match is surfaced (`none` / `ambiguous`) rather than
// silently linked, per the mapping design ("never blindly duplicated").

import { toCents } from '../money.ts';

export type MatchResult =
  | { kind: 'match'; qboId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: { qboId: string }[] };

function toMatchResult(matches: { qboId: string }[]): MatchResult {
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) {
    const [only] = matches;
    if (!only) return { kind: 'none' };
    return { kind: 'match', qboId: only.qboId };
  }
  return { kind: 'ambiguous', candidates: matches.map((m) => ({ qboId: m.qboId })) };
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export interface LocalContactLike {
  email?: string | null;
  displayName: string;
}

export interface QboCustomerLike {
  qboId: string;
  email?: string | null;
  displayName?: string | null;
}

/** Natural key for a contact: normalized email when present, else normalized display name. Not
 * used for matching directly (matching filters candidates field-by-field below) — exposed for
 * callers that want a stable dedup/log key. */
export function contactNaturalKey(c: LocalContactLike): string {
  const email = normalize(c.email);
  if (email) return `email:${email}`;
  return `name:${normalize(c.displayName) ?? ''}`;
}

/**
 * Matches a local contact against candidate QBO customers. Email is authoritative when the local
 * contact has one: matched purely on normalized (trimmed, case-insensitive) email, never falling
 * back to name (two different people can share a display name; email is the confident signal).
 * Only when the local contact has no email does display name decide, again exact-normalized.
 * Zero matches -> `none`; exactly one -> `match`; more than one (e.g. two QBO customers sharing
 * the same email) -> `ambiguous`, never auto-linked.
 */
export function matchContactByNaturalKey(
  local: LocalContactLike,
  candidates: QboCustomerLike[],
): MatchResult {
  const email = normalize(local.email);
  if (email) {
    return toMatchResult(candidates.filter((c) => normalize(c.email) === email));
  }

  const name = normalize(local.displayName);
  if (!name) return { kind: 'none' };
  return toMatchResult(candidates.filter((c) => normalize(c.displayName) === name));
}

export interface LocalInvoiceLike {
  docNumber?: string | null;
  total: string | number;
  txnDate: string;
  /** The local contact's already-resolved QBO customer id, if known — required to confidently
   * match an invoice with no docNumber (total + date alone isn't enough). */
  customerQboId?: string | null;
}

export interface QboInvoiceLike {
  qboId: string;
  docNumber?: string | null;
  total: string | number;
  txnDate: string;
  customerQboId?: string | null;
}

/** Natural key for an invoice: doc number when present (plus amount+date to disambiguate reused
 * doc numbers across time), else amount+date alone. Money is normalized to integer cents, never
 * compared as a float. Exposed for callers that want a stable dedup/log key. */
export function invoiceNaturalKey(t: {
  docNumber?: string | null;
  total: string | number;
  txnDate: string;
}): string {
  const cents = toCents(t.total);
  return t.docNumber ? `doc:${t.docNumber}:${cents}:${t.txnDate}` : `nodoc:${cents}:${t.txnDate}`;
}

/**
 * Matches a local invoice against candidate QBO invoices.
 *  - With a `docNumber`: confident match requires the same `docNumber` AND the same total
 *    (compared as integer cents, e.g. `'100.00'` matches `100` but not `100.01`) AND the same
 *    `txnDate`.
 *  - Without a `docNumber`: doc number alone isn't available to disambiguate, so total + date +
 *    the invoice's customer (by the customer's already-resolved QBO id) must all agree.
 * Either way, zero matches -> `none`, exactly one -> `match`, more than one -> `ambiguous`
 * (surfaced to a human — never guessed).
 */
export function matchInvoiceByNaturalKey(
  local: LocalInvoiceLike,
  candidates: QboInvoiceLike[],
): MatchResult {
  const localCents = toCents(local.total);

  if (local.docNumber) {
    return toMatchResult(
      candidates.filter(
        (c) =>
          c.docNumber === local.docNumber &&
          toCents(c.total) === localCents &&
          c.txnDate === local.txnDate,
      ),
    );
  }

  if (!local.customerQboId) return { kind: 'none' };
  return toMatchResult(
    candidates.filter(
      (c) =>
        toCents(c.total) === localCents &&
        c.txnDate === local.txnDate &&
        c.customerQboId === local.customerQboId,
    ),
  );
}
