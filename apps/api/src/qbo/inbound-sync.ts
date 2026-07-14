// Inbound sync: applies a webhook-notified QBO change to internal Invoice/Payment/Contact
// records, after the authoritative QBO state has already been refetched. Locked decisions (see
// `.claude/plans/20007-inbound-sync.md` §0a / `docs/design-decisions.md` ## Idempotency,
// ## Mapping, ## Failure handling):
//   1. Transactional claim+apply: the caller (`routes/qbo-webhook.ts`) refetches OUTSIDE any tx
//      (a network call must never hold a DB transaction open), then opens ONE `db.transaction`
//      that calls `recordEventIfNew(tx, …)` and, only if it returns `true`, calls
//      `applyInboundEntity(tx, …)` — so a crash between claim and commit rolls back the dedup
//      insert too, and Intuit's redelivery re-drives the event. This module only ever receives a
//      `tx` (never the top-level db) — it has no opinion on transaction boundaries, the caller
//      owns them.
//   2. Apply matrix: linked + Update -> patch local; linked + Void -> void local; linked +
//      Delete -> SOFT-DELETE local (`deletedAt`, distinct from void — 20009,
//      docs/design-decisions.md ## Delete vs void). Unlinked -> natural-key match (Contacts for
//      Customer, Invoices for Invoice); `match` -> link + apply, `ambiguous`/`none` -> skipped
//      audit, never auto-created/guessed. Unlinked + Void/Delete -> skipped (nothing local to
//      act on either way).
//   3. Inbound CREATE: an unlinked Invoice with a natural-key `none` result is IMPORTED (30016) —
//      the local `customer_invoice` is created from the refetched QBO state (contact resolved/
//      created from `CustomerRef`, sales lines mapped, balanced ledger posted) and linked to the
//      QBO id. Ambiguous matches still skip (never guessed). An unlinked Payment is ALSO imported
//      (30019) — there's no natural-key matcher for Payment (20004 only built Contact/Invoice
//      matchers) to try first, so every unlinked Payment goes straight to
//      `createLocalPaymentFromQbo`, which requires every invoice its `LinkedTxn`s reference to
//      already be linked locally (never guessed, never partially imported — an unresolvable
//      invoice skips the whole payment). Unlinked Customers still defer (no inbound Customer
//      create — see `applyCustomer`).
//   4. Content-update depth: invoice/payment METADATA (docNumber/txnDate/dueDate/memo) always
//      patches. 30015 extends invoices further: when the refetched QBO body carries a `Line[]`,
//      the local lines + ledger are re-posted too (delete+reinsert `transaction_lines`, zero + re-
//      post the ledger atomically in the SAME tx) — see `applyInvoiceLineResync` below. Guard: a
//      QBO total that would drop below the already-applied paid amount is never force-applied —
//      it's flagged `conflict` instead (`wouldUnderflowPaidAmount`, reusing 20010's `sync_links`/
//      conflicts-UI machinery), per the design call that each individual edit is independently
//      balanced so there's no ledger-integrity risk in surfacing it rather than rejecting/dropping
//      it. Payments still only ever patch metadata (no payment-amount re-sync — status-effect-on-
//      invoice-balance is driven by void/delete, not by an amount field patch).
//   5. No ordering/stale-skip guard yet (20008): the refetched state is applied blindly
//      (last-value-wins). `markSynced` still records the QBO SyncToken + a local version so
//      20008/20010 have something to compare against.
//   6. Merge/Emailed operations -> no-op apply + skipped audit.

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getAccountBySubtype } from '../accounts/service.ts';
import { writeAuditLog } from '../audit/service.ts';
import type * as schema from '../db/schema.ts';
import {
  contacts,
  items,
  paymentApplications,
  syncLinks,
  transactionLines,
  transactions,
} from '../db/schema.ts';
import {
  buildInvoicePostings,
  type InvoiceLineInput,
  insertCustomerInvoice,
} from '../invoices/service.ts';
import { postLedger, zeroOutLedger } from '../ledger/posting.ts';
import { formatCents, toCents } from '../money.ts';
import { deriveInvoiceStatus } from '../payments/status.ts';
import { type QboEntityEnvelope, type QboEntityType, unwrapEntity } from './api-client.ts';
import { isBothSidesConflict, wouldUnderflowPaidAmount } from './conflict.ts';
import {
  type LocalContactLike,
  type LocalInvoiceLike,
  matchContactByNaturalKey,
  matchInvoiceByNaturalKey,
  type QboCustomerLike,
  type QboInvoiceLike,
} from './natural-key.ts';
import { isStaleInboundApply } from './ordering.ts';
import {
  bumpLocalVersion,
  findLinkByLocal,
  findLinkByQbo,
  markConflict,
  markSynced,
  type SyncEntityType,
  type SyncLinkRow,
  upsertLink,
} from './sync-link-service.ts';
import type { WebhookEntity } from './webhook-types.ts';

type Db = NodePgDatabase<typeof schema>;
// This module is only ever called with the `tx` handle from the caller's `db.transaction(...)` —
// see decision #1 above. Never accepts the top-level `Db`.
type Tx = Parameters<Db['transaction']>[0] extends (tx: infer T, ...args: never[]) => unknown
  ? T
  : never;

// 20010: 'conflict' added — both-sides-changed detected at the apply seam (see `qbo/conflict.ts`
// / `docs/design-decisions.md` ## Conflict resolution). Distinct from 'skipped': a conflict is
// surfaced in `GET /api/conflicts` for a human to resolve, a plain skip is just an audited no-op.
export type InboundAction =
  | 'updated'
  | 'voided'
  | 'deleted'
  | 'linked'
  | 'created'
  | 'skipped'
  | 'unmatched'
  | 'conflict';

export interface InboundResult {
  action: InboundAction;
  localId?: string;
  reason?: string;
}

export interface ApplyInboundEntityInput {
  orgId: string;
  realmId: string;
  entityType: QboEntityType;
  entity: WebhookEntity;
  /** Already-refetched QBO envelope — the network call happened OUTSIDE this tx (see caller). */
  refetched: QboEntityEnvelope;
  /** 20010: set only by the conflict-resolution route's `winner:'qbo'` path — the user has
   * explicitly chosen the QBO version to win, so both the already-in-conflict "held" gate and
   * the both-sides-changed check are bypassed and the normal apply logic runs. Never set by the
   * webhook path. */
  bypassConflict?: boolean;
}

// Split (20009, docs/design-decisions.md ## Delete vs void): `Void` and `Delete` used to collapse
// to the same local void. Now `VOID_OPERATIONS`/`DELETE_OPERATIONS` drive distinct branches in
// `applyLinkedInvoice`/`applyLinkedPayment` (void local vs soft-delete local), while
// `VOID_OR_DELETE_OPERATIONS` is still used everywhere the two remain equivalent — i.e. anywhere
// there's simply nothing local to act on regardless of which one QBO sent (unlinked
// invoice/customer, any operation on a Contact — a Contact has no void OR delete state locally).
const VOID_OPERATIONS = new Set(['Void']);
const DELETE_OPERATIONS = new Set(['Delete']);
const VOID_OR_DELETE_OPERATIONS = new Set(['Void', 'Delete']);
const NOOP_OPERATIONS = new Set(['Merge', 'Emailed']);

async function audit(
  tx: Tx,
  input: ApplyInboundEntityInput,
  localId: string | null,
  action: string,
  outcome: 'success' | 'failure' | 'skipped',
  detail: Record<string, unknown>,
): Promise<void> {
  await writeAuditLog(tx, {
    orgId: input.orgId,
    userId: null,
    entityType: input.entity.name,
    localId,
    action,
    direction: 'inbound',
    outcome,
    triggeringEvent: `${input.realmId}:${input.entity.name}:${input.entity.id}:${input.entity.operation}`,
    detail: { qboId: input.entity.id, operation: input.entity.operation, ...detail },
  });
}

/**
 * Every local record type this task can be told is already linked to a *different* local record
 * (loaded once per invocation) — used to exclude already-linked rows from natural-key candidate
 * sets, since matching against an already-linked row would either be a wasted comparison or (if
 * it somehow matched) a `ConflictingLinkError` from `upsertLink`.
 */
async function loadLinkedLocalIds(
  tx: Tx,
  orgId: string,
  entityType: SyncEntityType,
): Promise<Set<string>> {
  const rows = await tx
    .select({ localId: syncLinks.localId })
    .from(syncLinks)
    .where(and(eq(syncLinks.orgId, orgId), eq(syncLinks.entityType, entityType)));
  return new Set(rows.map((r) => r.localId));
}

// ---------------------------------------------------------------------------
// Pure mappers (unit-testable without a DB).
// ---------------------------------------------------------------------------

export interface InvoiceMetadataPatch {
  docNumber?: string | null;
  txnDate?: string;
  dueDate?: string | null;
  memo?: string | null;
}

/** QBO -> local metadata patch for an Invoice. Deliberately scoped to fields that never touch
 * amounts/lines (decision #4) — `DocNumber`/`TxnDate`/`DueDate`/`PrivateNote` only. Only includes
 * a key when QBO's response actually carries that field, so a caller applying this patch never
 * clobbers a local value with `undefined`. */
export function qboInvoiceToLocalPatch(qbo: Record<string, unknown>): InvoiceMetadataPatch {
  const patch: InvoiceMetadataPatch = {};
  if ('DocNumber' in qbo)
    patch.docNumber = typeof qbo.DocNumber === 'string' ? qbo.DocNumber : null;
  if (typeof qbo.TxnDate === 'string') patch.txnDate = qbo.TxnDate;
  if ('DueDate' in qbo) patch.dueDate = typeof qbo.DueDate === 'string' ? qbo.DueDate : null;
  if ('PrivateNote' in qbo)
    patch.memo = typeof qbo.PrivateNote === 'string' ? qbo.PrivateNote : null;
  return patch;
}

export interface QboInvoiceLinePatch {
  description: string | null;
  quantity: string;
  unitPrice: string;
  amountCents: number;
  /** The QBO item id this line's `SalesItemLineDetail.ItemRef` pointed at, or null for a plain
   * amount line with no item. Resolved to a local item (via `sync_links`) by `resolveInboundLines`
   * — this pure mapper never touches the DB. */
  itemQboId: string | null;
}

/**
 * QBO -> local line patch for an Invoice (30015, the decision #4 line/amount re-sync). Returns
 * `undefined` when the refetched body carries no `Line` array at all — same "only includes a key
 * QBO actually sent" discipline as `qboInvoiceToLocalPatch`, so a caller never mistakes "QBO
 * didn't say" for "QBO said zero lines". Only `SalesItemLineDetail` entries are mapped (the only
 * kind `buildQboInvoice` ever produces outbound); a subtotal/discount/tax line from a QBO-native
 * edit is skipped rather than guessed at, matching the outbound mapper's own scope
 * (`buildQboInvoice` in `qbo/outbound-sync.ts`).
 */
export function qboInvoiceToLocalLines(
  qbo: Record<string, unknown>,
): QboInvoiceLinePatch[] | undefined {
  if (!Array.isArray(qbo.Line)) return undefined;

  const lines: QboInvoiceLinePatch[] = [];
  for (const raw of qbo.Line) {
    if (!raw || typeof raw !== 'object') continue;
    const line = raw as Record<string, unknown>;
    if (line.DetailType !== 'SalesItemLineDetail') continue;

    const detail = (line.SalesItemLineDetail as Record<string, unknown> | undefined) ?? {};
    const amountCents =
      typeof line.Amount === 'number' || typeof line.Amount === 'string' ? toCents(line.Amount) : 0;
    const quantity = typeof detail.Qty === 'number' && detail.Qty > 0 ? detail.Qty : 1;
    const unitPriceCents =
      typeof detail.UnitPrice === 'number' || typeof detail.UnitPrice === 'string'
        ? toCents(detail.UnitPrice)
        : Math.round(amountCents / quantity);

    lines.push({
      description: typeof line.Description === 'string' ? line.Description : null,
      quantity: String(quantity),
      unitPrice: formatCents(unitPriceCents),
      amountCents,
      itemQboId: (detail.ItemRef as { value?: string } | undefined)?.value ?? null,
    });
  }
  return lines;
}

export interface PaymentMetadataPatch {
  txnDate?: string;
  memo?: string | null;
}

/** QBO -> local metadata patch for a Payment. Same scoping rule as invoices: no amount/status
 * fields (decision #4) — those are only ever changed via the Void/Delete path, which reuses the
 * existing zero-ledger + invoice-recompute machinery instead of a field patch. */
export function qboPaymentToLocalPatch(qbo: Record<string, unknown>): PaymentMetadataPatch {
  const patch: PaymentMetadataPatch = {};
  if (typeof qbo.TxnDate === 'string') patch.txnDate = qbo.TxnDate;
  if ('PrivateNote' in qbo)
    patch.memo = typeof qbo.PrivateNote === 'string' ? qbo.PrivateNote : null;
  return patch;
}

/** Extracts the natural-key-relevant fields off a refetched QBO Invoice, in the shape
 * `matchInvoiceByNaturalKey` expects for its `local` argument. Used in reverse of the outbound
 * direction: here the "local" role is played by the *incoming* QBO invoice (the one thing we
 * know), and the *candidates* are our own unlinked local invoices — see `qboIdAliasedCandidate`
 * below for how the local id rides through the matcher's `qboId` field. */
export function qboInvoiceToMatchTarget(qbo: Record<string, unknown>): LocalInvoiceLike {
  const total = qbo.TotalAmt;
  return {
    docNumber: typeof qbo.DocNumber === 'string' ? qbo.DocNumber : null,
    total: typeof total === 'number' || typeof total === 'string' ? total : 0,
    txnDate: typeof qbo.TxnDate === 'string' ? qbo.TxnDate : '',
    customerQboId: (qbo.CustomerRef as { value?: string } | undefined)?.value ?? null,
  };
}

/** Same reversal as `qboInvoiceToMatchTarget`, for Customer -> Contact matching. */
export function qboCustomerToMatchTarget(qbo: Record<string, unknown>): LocalContactLike {
  const email = (qbo.PrimaryEmailAddr as { Address?: string } | undefined)?.Address ?? null;
  return {
    email,
    displayName: typeof qbo.DisplayName === 'string' ? qbo.DisplayName : '',
  };
}

interface QboSalesLineDetail {
  Qty?: unknown;
  UnitPrice?: unknown;
}

/**
 * Maps a refetched QBO Invoice's `Line[]` to local `InvoiceLineInput[]` for an inbound CREATE
 * (30016). Only `SalesItemLineDetail` lines carry an amount we post as income — every other
 * `DetailType` (e.g. `SubTotalLineDetail`, `DiscountLineDetail`) is skipped, so the mapped lines
 * always sum to the sales total and the local ledger the caller posts from them is balanced by
 * construction (debit A/R = credit income). `Qty` defaults to 1; `UnitPrice` falls back to the
 * line `Amount` (so a bare amount line still round-trips). No account mapping here — the caller
 * posts every line to the default Sales Income account, mirroring a local create (30016 decision:
 * QBO invoice lines don't carry an income-account ref, only the item does).
 */
export function mapQboInvoiceLines(qbo: Record<string, unknown>): InvoiceLineInput[] {
  const rawLines = Array.isArray(qbo.Line) ? qbo.Line : [];
  const lines: InvoiceLineInput[] = [];
  for (const raw of rawLines) {
    if (!raw || typeof raw !== 'object') continue;
    const line = raw as Record<string, unknown>;
    if (line.DetailType !== 'SalesItemLineDetail') continue;

    const detail = (line.SalesItemLineDetail as QboSalesLineDetail | undefined) ?? {};
    const amount = typeof line.Amount === 'number' ? line.Amount : Number(line.Amount);
    if (!Number.isFinite(amount)) continue;

    const qtyRaw = typeof detail.Qty === 'number' ? detail.Qty : Number(detail.Qty);
    const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;

    const unitPriceRaw =
      typeof detail.UnitPrice === 'number' ? detail.UnitPrice : Number(detail.UnitPrice);
    // Fall back to amount/qty so the posted amount (qty * unitPrice) reproduces QBO's line total.
    const unitPrice = Number.isFinite(unitPriceRaw) ? unitPriceRaw : amount / quantity;

    lines.push({
      quantity,
      unitPrice,
      description: typeof line.Description === 'string' ? line.Description : undefined,
    });
  }
  return lines;
}

export interface QboPaymentLinePatch {
  amountCents: number;
  /** The QBO id of the Invoice this line's `LinkedTxn` applies to. Resolved to a local invoice
   * (via `sync_links`) by `createLocalPaymentFromQbo` — this pure mapper never touches the DB. */
  invoiceQboId: string;
}

/**
 * Maps a refetched QBO Payment's `Line[]` to `{amountCents, invoiceQboId}[]` for an inbound
 * CREATE. Mirrors `mapQboInvoiceLines`'s scope discipline: only lines whose `LinkedTxn` includes a
 * `TxnType: 'Invoice'` entry are mapped (the only shape `buildQboPayment` ever produces outbound —
 * a `LinkedTxn` to something other than an Invoice, or no `LinkedTxn` at all, is skipped rather
 * than guessed at) and a non-positive/unparseable `Amount` is dropped. Every mapped line always
 * has a resolvable `invoiceQboId`, so the caller's per-line invoice lookup never has to branch on
 * a missing id.
 */
export function qboPaymentToLocalLines(qbo: Record<string, unknown>): QboPaymentLinePatch[] {
  const rawLines = Array.isArray(qbo.Line) ? qbo.Line : [];
  const lines: QboPaymentLinePatch[] = [];
  for (const raw of rawLines) {
    if (!raw || typeof raw !== 'object') continue;
    const line = raw as Record<string, unknown>;

    const amountCents =
      typeof line.Amount === 'number' || typeof line.Amount === 'string' ? toCents(line.Amount) : 0;
    if (amountCents <= 0) continue;

    const linkedTxns = Array.isArray(line.LinkedTxn) ? line.LinkedTxn : [];
    const invoiceLink = linkedTxns.find(
      (candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        (candidate as Record<string, unknown>).TxnType === 'Invoice',
    ) as Record<string, unknown> | undefined;
    const invoiceQboId = typeof invoiceLink?.TxnId === 'string' ? invoiceLink.TxnId : null;
    if (!invoiceQboId) continue;

    lines.push({ amountCents, invoiceQboId });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Candidate loaders (org-scoped; exclude rows already claimed by a different sync_links row).
// ---------------------------------------------------------------------------

export interface ContactCandidateRow {
  localId: string;
  email: string | null;
  displayName: string;
}

export async function loadContactCandidates(tx: Tx, orgId: string): Promise<ContactCandidateRow[]> {
  const linkedIds = await loadLinkedLocalIds(tx, orgId, 'contact');
  const rows = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.isCustomer, true)));
  return rows
    .filter((r) => !linkedIds.has(r.id))
    .map((r) => ({ localId: r.id, email: r.email, displayName: r.displayName }));
}

export interface InvoiceCandidateRow {
  localId: string;
  docNumber: string | null;
  total: string;
  txnDate: string;
  /** The candidate invoice's own contact's already-resolved QBO customer id, or null if that
   * contact isn't linked yet. Needed to disambiguate a doc-number-less match (see
   * `matchInvoiceByNaturalKey`). */
  customerQboId: string | null;
}

export async function loadInvoiceCandidates(tx: Tx, orgId: string): Promise<InvoiceCandidateRow[]> {
  const linkedIds = await loadLinkedLocalIds(tx, orgId, 'transaction');
  const rows = await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.orgId, orgId), eq(transactions.type, 'customer_invoice')));

  const candidates: InvoiceCandidateRow[] = [];
  for (const row of rows) {
    if (linkedIds.has(row.id)) continue;
    let customerQboId: string | null = null;
    if (row.contactId) {
      const contactLink = await findLinkByLocal(tx, orgId, 'contact', row.contactId);
      customerQboId = contactLink?.qboId ?? null;
    }
    candidates.push({
      localId: row.id,
      docNumber: row.docNumber,
      total: row.total,
      txnDate: row.txnDate,
      customerQboId,
    });
  }
  return candidates;
}

function asQboCustomerLike(candidates: ContactCandidateRow[]): QboCustomerLike[] {
  // The natural-key matchers were built for the outbound direction (local record vs *QBO*
  // candidates) and return the winning candidate's `qboId`. Here the candidates are our own
  // unlinked local contacts, so `qboId` is aliased to carry the candidate's *local* id — the
  // matcher only ever echoes it back, never interprets it, so this is safe.
  return candidates.map((c) => ({ qboId: c.localId, email: c.email, displayName: c.displayName }));
}

function asQboInvoiceLike(candidates: InvoiceCandidateRow[]): QboInvoiceLike[] {
  // Same aliasing trick as `asQboCustomerLike`, for invoices.
  return candidates.map((c) => ({
    qboId: c.localId,
    docNumber: c.docNumber,
    total: c.total,
    txnDate: c.txnDate,
    customerQboId: c.customerQboId,
  }));
}

// ---------------------------------------------------------------------------
// Invoice apply.
// ---------------------------------------------------------------------------

async function voidLocalInvoiceRow(
  tx: Tx,
  orgId: string,
  existing: typeof transactions.$inferSelect,
): Promise<void> {
  await zeroOutLedger(tx, {
    orgId,
    transactionId: existing.id,
    entryDate: existing.txnDate,
    contactId: existing.contactId,
  });
  await tx
    .update(transactions)
    .set({ status: 'void', balance: '0.00', version: existing.version + 1, updatedAt: new Date() })
    .where(and(eq(transactions.orgId, orgId), eq(transactions.id, existing.id)));
}

/**
 * Soft-delete counterpart to `voidLocalInvoiceRow` (20009 §0a.3): sets `deletedAt` instead of
 * `status: 'void'` — `deletedAt` is orthogonal to `status`, so whatever status the invoice had
 * (open or void) is left untouched. Zeroes the ledger the same way void does (a deleted invoice
 * has no accounting effect either). Deliberately does NOT touch `payment_applications` — an
 * inbound QBO delete of a locally-paid invoice still soft-deletes locally to mirror reality, but
 * leaves the applied payments intact (the delete-of-paid-in-both conflict nuance is 20010's
 * concern; this is a clean seam, not a reversal).
 */
async function softDeleteLocalInvoiceRow(
  tx: Tx,
  orgId: string,
  existing: typeof transactions.$inferSelect,
): Promise<void> {
  await zeroOutLedger(tx, {
    orgId,
    transactionId: existing.id,
    entryDate: existing.txnDate,
    contactId: existing.contactId,
  });
  await tx
    .update(transactions)
    .set({
      deletedAt: new Date(),
      balance: '0.00',
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.orgId, orgId), eq(transactions.id, existing.id)));
}

async function applyInvoiceMetadataPatch(
  tx: Tx,
  orgId: string,
  existing: typeof transactions.$inferSelect,
  qbo: Record<string, unknown>,
): Promise<InvoiceMetadataPatch> {
  const patch = qboInvoiceToLocalPatch(qbo);
  await tx
    .update(transactions)
    .set({
      docNumber: patch.docNumber !== undefined ? patch.docNumber : existing.docNumber,
      txnDate: patch.txnDate ?? existing.txnDate,
      dueDate: patch.dueDate !== undefined ? patch.dueDate : existing.dueDate,
      memo: patch.memo !== undefined ? patch.memo : existing.memo,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.orgId, orgId), eq(transactions.id, existing.id)));
  return patch;
}

function qboSyncToken(qbo: Record<string, unknown>): string | undefined {
  return typeof qbo.SyncToken === 'string' ? qbo.SyncToken : undefined;
}

function qboLastUpdated(qbo: Record<string, unknown>): string | undefined {
  const meta = qbo.MetaData as { LastUpdatedTime?: unknown } | undefined;
  return typeof meta?.LastUpdatedTime === 'string' ? meta.LastUpdatedTime : undefined;
}

/** Ordering guard (20008, `.claude/plans/20008-ordering.md` §0a): `true` when the refetched QBO
 * state is not newer than what the link already has recorded — SyncToken primary, LastUpdatedTime
 * vs `lastSyncedAt` fallback, never stale on a first-ever apply. Only meaningful for LINKED
 * records (there's nothing "recorded" to be newer than on an unlinked/natural-key-link path). */
function isLinkStale(link: SyncLinkRow, qbo: Record<string, unknown>): boolean {
  return isStaleInboundApply(
    { storedSyncToken: link.qboSyncToken, storedLastSyncedAt: link.lastSyncedAt },
    { incomingSyncToken: qboSyncToken(qbo), incomingLastUpdated: qboLastUpdated(qbo) },
  );
}

/**
 * Both-sides-changed conflict check (20010 §0a.1/§0a.2). Called from every linked Invoice/Payment
 * Update/Void/Delete branch, AFTER that branch's own `isLinkStale` early-return and BEFORE any
 * mutation — so a genuine conflict is caught before either side's change is applied, and the
 * stored SyncToken/localVersion are left at their pre-conflict snapshot. Returns the terminal
 * `InboundResult` to return from the caller when a conflict was raised, or `null` to continue
 * with the normal apply. `input.bypassConflict` (set only by the resolution route's
 * `winner:'qbo'` path) always returns `null` — the user already chose a winner. */
async function handleConflictIfAny(
  tx: Tx,
  input: ApplyInboundEntityInput,
  link: SyncLinkRow,
  existing: { id: string; version: number },
  qbo: Record<string, unknown>,
): Promise<InboundResult | null> {
  if (input.bypassConflict) return null;

  const stale = isLinkStale(link, qbo);
  if (
    !isBothSidesConflict(
      { storedLocalVersion: link.localVersion, txnVersion: existing.version },
      stale,
    )
  ) {
    return null;
  }

  await markConflict(tx, input.orgId, 'transaction', existing.id);
  await audit(tx, input, existing.id, 'qbo.inbound.conflict', 'skipped', {
    reason: 'both_sides_changed',
    storedLocalVersion: link.localVersion,
    txnVersion: existing.version,
    storedSyncToken: link.qboSyncToken,
    incomingSyncToken: qboSyncToken(qbo),
  });
  return { action: 'conflict', localId: existing.id, reason: 'both_sides_changed' };
}

/**
 * Already-`conflict` hold (20010 §0a.3): a subsequent inbound event on a link already in
 * conflict is idempotent — re-run the stale check (an old/duplicate redelivery is still just
 * `stale_ignored`), otherwise hold it in conflict with no mutation (`conflict_held` audit).
 * Bypassed when `input.bypassConflict` is set (the resolution route's `winner:'qbo'` re-drive
 * must actually apply against an in-conflict link). */
async function handleAlreadyConflictHold(
  tx: Tx,
  input: ApplyInboundEntityInput,
  link: SyncLinkRow,
  existing: { id: string },
  qbo: Record<string, unknown>,
): Promise<InboundResult | null> {
  if (input.bypassConflict || link.state !== 'conflict') return null;

  if (isLinkStale(link, qbo)) {
    await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', { reason: 'stale_ignored' });
    return { action: 'skipped', localId: existing.id, reason: 'stale_ignored' };
  }

  await audit(tx, input, existing.id, 'qbo.inbound.conflict_held', 'skipped', {
    reason: 'conflict_held',
  });
  return { action: 'conflict', localId: existing.id, reason: 'conflict_held' };
}

// ---------------------------------------------------------------------------
// 30015: inbound invoice line/amount re-sync.
// ---------------------------------------------------------------------------

interface ResolvedInboundLine {
  lineNumber: number;
  itemId: string | null;
  accountId: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amountCents: number;
}

/** Resolves each QBO line's `ItemRef` to a local item (via `sync_links`, `qboType: 'Item'`) and,
 * when that item has an `incomeAccountId`, posts to it — otherwise (no `ItemRef`, or the item
 * isn't linked/has no income account) falls back to `defaultIncomeAccountId`, the same default
 * `resolveLines` uses outbound-of-this-direction in `invoices/service.ts`. Never blocks the
 * re-sync on an unmapped item — an unresolvable `ItemRef` just posts as a plain line, matching the
 * "surface genuine conflicts, don't over-engineer the rest" design call. */
async function resolveInboundLines(
  tx: Tx,
  orgId: string,
  qboLines: QboInvoiceLinePatch[],
  defaultIncomeAccountId: string,
): Promise<ResolvedInboundLine[]> {
  const resolved: ResolvedInboundLine[] = [];
  for (const [index, line] of qboLines.entries()) {
    let itemId: string | null = null;
    let accountId = defaultIncomeAccountId;

    if (line.itemQboId) {
      const itemLink = await findLinkByQbo(tx, orgId, 'Item', line.itemQboId);
      if (itemLink) {
        itemId = itemLink.localId;
        const [item] = await tx
          .select()
          .from(items)
          .where(and(eq(items.orgId, orgId), eq(items.id, itemId)))
          .limit(1);
        if (item?.incomeAccountId) accountId = item.incomeAccountId;
      }
    }

    resolved.push({
      lineNumber: index + 1,
      itemId,
      accountId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amountCents: line.amountCents,
    });
  }
  return resolved;
}

/** Sum of every `payment_applications` row currently applied to an invoice, in integer cents —
 * the "already-applied paid amount" the underflow guard compares a re-synced total against. Also
 * used by `recomputeLocalInvoiceBalance` below (single source of truth for this sum). */
async function sumAppliedPaymentsCents(tx: Tx, orgId: string, invoiceId: string): Promise<number> {
  const applications = await tx
    .select()
    .from(paymentApplications)
    .where(
      and(eq(paymentApplications.orgId, orgId), eq(paymentApplications.invoiceTxnId, invoiceId)),
    );
  return applications.reduce((sum, a) => sum + toCents(a.amount), 0);
}

/**
 * The line/amount half of decision #4 (30015): called only when the refetched QBO Invoice body
 * carries at least one mappable `SalesItemLineDetail` line. Re-posts `transaction_lines` +
 * `ledger_entries` atomically in the SAME tx as the metadata patch — delete+reinsert lines
 * (mirrors `updateInvoice` in `invoices/service.ts`), `zeroOutLedger` then `postLedger` with the
 * new balanced set. Guard: if the new total would drop below what's already been recorded as PAID
 * (`wouldUnderflowPaidAmount`), nothing is mutated — the link goes to `conflict` instead, same
 * shape as `handleConflictIfAny`'s both-sides-changed conflict, so a human resolves it via the
 * conflicts UI rather than the ledger silently going negative or a payment being stranded above
 * the new total.
 */
async function applyInvoiceLineResync(
  tx: Tx,
  input: ApplyInboundEntityInput,
  existing: typeof transactions.$inferSelect,
  qbo: Record<string, unknown>,
  qboLines: QboInvoiceLinePatch[],
): Promise<InboundResult> {
  const ar = await getAccountBySubtype(tx, input.orgId, 'accounts_receivable');
  const salesIncome = await getAccountBySubtype(tx, input.orgId, 'sales_income');
  if (!ar || !salesIncome) {
    throw new Error(`qbo inbound line resync: chart of accounts not seeded for org ${input.orgId}`);
  }

  const paidCents = await sumAppliedPaymentsCents(tx, input.orgId, existing.id);
  const resolvedLines = await resolveInboundLines(tx, input.orgId, qboLines, salesIncome.id);
  const totalCents = resolvedLines.reduce((sum, line) => sum + line.amountCents, 0);

  if (wouldUnderflowPaidAmount(totalCents, paidCents)) {
    await markConflict(tx, input.orgId, 'transaction', existing.id);
    await audit(tx, input, existing.id, 'qbo.inbound.conflict', 'skipped', {
      reason: 'line_resync_would_underflow_paid_amount',
      totalCents,
      paidCents,
    });
    return {
      action: 'conflict',
      localId: existing.id,
      reason: 'line_resync_would_underflow_paid_amount',
    };
  }

  const metadataPatch = qboInvoiceToLocalPatch(qbo);

  await tx
    .delete(transactionLines)
    .where(
      and(eq(transactionLines.orgId, input.orgId), eq(transactionLines.transactionId, existing.id)),
    );
  await tx.insert(transactionLines).values(
    resolvedLines.map((line) => ({
      orgId: input.orgId,
      transactionId: existing.id,
      lineNumber: line.lineNumber,
      itemId: line.itemId,
      accountId: line.accountId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: formatCents(line.amountCents),
    })),
  );

  await zeroOutLedger(tx, {
    orgId: input.orgId,
    transactionId: existing.id,
    entryDate: existing.txnDate,
    contactId: existing.contactId,
  });
  await postLedger(tx, {
    orgId: input.orgId,
    transactionId: existing.id,
    entryDate: existing.txnDate,
    lines: buildInvoicePostings(resolvedLines, ar.id, existing.contactId),
  });

  const status = deriveInvoiceStatus(totalCents, paidCents);
  await tx
    .update(transactions)
    .set({
      docNumber:
        metadataPatch.docNumber !== undefined ? metadataPatch.docNumber : existing.docNumber,
      txnDate: metadataPatch.txnDate ?? existing.txnDate,
      dueDate: metadataPatch.dueDate !== undefined ? metadataPatch.dueDate : existing.dueDate,
      memo: metadataPatch.memo !== undefined ? metadataPatch.memo : existing.memo,
      subtotal: formatCents(totalCents),
      total: formatCents(totalCents),
      balance: formatCents(totalCents - Math.min(paidCents, totalCents)),
      status,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.orgId, input.orgId), eq(transactions.id, existing.id)));

  await markSynced(tx, input.orgId, 'transaction', existing.id, {
    qboSyncToken: qboSyncToken(qbo),
    localVersion: existing.version + 1,
    lastSyncedAt: new Date(),
  });
  await audit(tx, input, existing.id, 'qbo.inbound.update', 'success', {
    fields: [...Object.keys(metadataPatch), 'lines', 'total'],
  });
  return { action: 'updated', localId: existing.id };
}

async function applyLinkedInvoice(
  tx: Tx,
  input: ApplyInboundEntityInput,
  link: SyncLinkRow,
  qbo: Record<string, unknown>,
): Promise<InboundResult> {
  const localId = link.localId;
  const [existing] = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.orgId, input.orgId),
        eq(transactions.id, localId),
        eq(transactions.type, 'customer_invoice'),
      ),
    )
    .limit(1);
  if (!existing) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: 'linked_local_row_missing',
    });
    return { action: 'skipped', reason: 'linked_local_row_missing' };
  }

  // Terminal state (20009 §0a.5 "delete then anything -> terminal"): once soft-deleted, ANY
  // further inbound operation (Update/Void/redelivered Delete) on this record is an idempotent
  // no-op — there is nothing left locally to update, void, or delete again.
  if (existing.deletedAt) {
    await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
      reason: 'already_deleted',
    });
    return { action: 'skipped', localId: existing.id, reason: 'already_deleted' };
  }

  const held = await handleAlreadyConflictHold(tx, input, link, existing, qbo);
  if (held) return held;

  if (DELETE_OPERATIONS.has(input.entity.operation)) {
    if (!input.bypassConflict && isLinkStale(link, qbo)) {
      await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
        reason: 'stale_ignored',
      });
      return { action: 'skipped', localId: existing.id, reason: 'stale_ignored' };
    }
    const conflict = await handleConflictIfAny(tx, input, link, existing, qbo);
    if (conflict) return conflict;
    await softDeleteLocalInvoiceRow(tx, input.orgId, existing);
    await markSynced(tx, input.orgId, 'transaction', existing.id, {
      qboSyncToken: qboSyncToken(qbo),
      localVersion: existing.version + 1,
      lastSyncedAt: new Date(),
    });
    await audit(tx, input, existing.id, 'qbo.inbound.delete', 'success', {});
    return { action: 'deleted', localId: existing.id };
  }

  if (VOID_OPERATIONS.has(input.entity.operation)) {
    if (existing.status === 'void') {
      await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
        reason: 'already_void',
      });
      return { action: 'skipped', localId: existing.id, reason: 'already_void' };
    }
    if (!input.bypassConflict && isLinkStale(link, qbo)) {
      await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
        reason: 'stale_ignored',
      });
      return { action: 'skipped', localId: existing.id, reason: 'stale_ignored' };
    }
    // 20010 carried-forward edge (§0a.3, 20008 note): local dirty (edited, not voided — the
    // `existing.status === 'void'` case above already returned) + a genuinely-newer inbound Void
    // is both-sides-changed, not a silent void. Also catches the voided-in-both case: a locally
    // *paid* invoice with an inbound Void used to zero the ledger while leaving
    // `payment_applications` intact (A/R net-negative) — now it stops here instead.
    const conflict = await handleConflictIfAny(tx, input, link, existing, qbo);
    if (conflict) return conflict;
    await voidLocalInvoiceRow(tx, input.orgId, existing);
    await markSynced(tx, input.orgId, 'transaction', existing.id, {
      qboSyncToken: qboSyncToken(qbo),
      localVersion: existing.version + 1,
      lastSyncedAt: new Date(),
    });
    await audit(tx, input, existing.id, 'qbo.inbound.void', 'success', {});
    return { action: 'voided', localId: existing.id };
  }

  if (existing.status === 'void') {
    // Never un-void from an inbound Update — orthogonal to 20010's both-sides-changed conflict
    // (this is a local-void status guard, not a version comparison): a locally-voided invoice has
    // nothing left to "conflict" over via a metadata patch, so it stays a plain skip.
    await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
      reason: 'local_already_void_no_unvoid',
    });
    return { action: 'skipped', localId: existing.id, reason: 'local_already_void_no_unvoid' };
  }

  if (!input.bypassConflict && isLinkStale(link, qbo)) {
    await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
      reason: 'stale_ignored',
    });
    return { action: 'skipped', localId: existing.id, reason: 'stale_ignored' };
  }

  const conflict = await handleConflictIfAny(tx, input, link, existing, qbo);
  if (conflict) return conflict;

  // 30015: when QBO's refetched body describes lines, re-sync them (+ the ledger) alongside the
  // metadata patch, instead of the metadata-only path below. `undefined`/empty means QBO's payload
  // didn't carry a `Line[]` at all — fall through to the metadata-only patch unchanged.
  const qboLines = qboInvoiceToLocalLines(qbo);
  if (qboLines && qboLines.length > 0) {
    return applyInvoiceLineResync(tx, input, existing, qbo, qboLines);
  }

  const patch = await applyInvoiceMetadataPatch(tx, input.orgId, existing, qbo);
  await markSynced(tx, input.orgId, 'transaction', existing.id, {
    qboSyncToken: qboSyncToken(qbo),
    localVersion: existing.version + 1,
    lastSyncedAt: new Date(),
  });
  await audit(tx, input, existing.id, 'qbo.inbound.update', 'success', {
    fields: Object.keys(patch),
  });
  return { action: 'updated', localId: existing.id };
}

async function linkUnmatchedInvoice(
  tx: Tx,
  input: ApplyInboundEntityInput,
  qbo: Record<string, unknown>,
): Promise<InboundResult> {
  if (VOID_OR_DELETE_OPERATIONS.has(input.entity.operation)) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: 'unlinked_nothing_to_void',
    });
    return { action: 'skipped', reason: 'unlinked_nothing_to_void' };
  }

  const target = qboInvoiceToMatchTarget(qbo);
  const candidateRows = await loadInvoiceCandidates(tx, input.orgId);
  const result = matchInvoiceByNaturalKey(target, asQboInvoiceLike(candidateRows));

  // Ambiguous stays a skip — never guess which of several identical local candidates is "the"
  // match (docs/design-decisions.md ## Mapping).
  if (result.kind === 'ambiguous') {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: 'ambiguous_natural_key_match',
      candidateCount: result.candidates.length,
    });
    return { action: 'unmatched', reason: 'ambiguous_natural_key_match' };
  }

  // 30016: no local link AND no natural-key match -> import the QBO invoice (create + link),
  // closing the "pre-existing invoice only in QBO" edge case beyond today's match-only path.
  if (result.kind === 'none') {
    return createLocalInvoiceFromQbo(tx, input, qbo);
  }

  // `result.qboId` is our aliased local id — see `asQboInvoiceLike`.
  const localId = result.qboId;
  const [localInvoice] = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.orgId, input.orgId),
        eq(transactions.id, localId),
        eq(transactions.type, 'customer_invoice'),
      ),
    )
    .limit(1);
  if (!localInvoice) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'failure', {
      reason: 'matched_row_missing',
      localId,
    });
    return { action: 'skipped', reason: 'matched_row_missing' };
  }

  await upsertLink(tx, {
    orgId: input.orgId,
    entityType: 'transaction',
    localId,
    qboType: 'Invoice',
    qboId: input.entity.id,
    state: 'synced',
    localVersion: localInvoice.version,
    qboSyncToken: qboSyncToken(qbo) ?? null,
    lastSyncedAt: new Date(),
  });

  if (localInvoice.status !== 'void') {
    await applyInvoiceMetadataPatch(tx, input.orgId, localInvoice, qbo);
    // 20007 seam fix (20008 §0a.3): the metadata patch above just bumped the txn row to
    // `version + 1`, but the link write above stamped `localVersion` at the PRE-patch version —
    // re-stamp it to the post-patch version so the recorded version matches what's actually
    // applied (otherwise the outbound redundant-write guard would see a stale localVersion and
    // re-push a document that's already current).
    await markSynced(tx, input.orgId, 'transaction', localId, {
      localVersion: localInvoice.version + 1,
    });
  }

  await audit(tx, input, localId, 'qbo.inbound.link', 'success', { matchedBy: 'natural_key' });
  return { action: 'linked', localId };
}

/**
 * Resolves the local contact for an inbound-created invoice from the QBO `CustomerRef`, creating +
 * linking one when the referenced QBO customer has no local link yet (30016). Returns null only
 * when the invoice carries no usable `CustomerRef.value` — a QBO invoice always references a
 * customer, so that's a defensive skip, not an expected path. The new contact is keyed to the QBO
 * Customer id via `sync_links` so a later Customer webhook (or another invoice referencing the same
 * customer) reuses it instead of creating a duplicate.
 */
async function resolveOrCreateContactFromRef(
  tx: Tx,
  input: ApplyInboundEntityInput,
  qbo: Record<string, unknown>,
): Promise<string | null> {
  const ref = qbo.CustomerRef as { value?: unknown; name?: unknown } | undefined;
  const qboCustomerId = typeof ref?.value === 'string' ? ref.value : null;
  if (!qboCustomerId) return null;

  const existing = await findLinkByQbo(tx, input.orgId, 'Customer', qboCustomerId);
  if (existing) return existing.localId;

  const refName = typeof ref?.name === 'string' ? ref.name.trim() : '';
  const displayName = refName || `QuickBooks customer ${qboCustomerId}`;
  const [contact] = await tx
    .insert(contacts)
    .values({ orgId: input.orgId, displayName, isCustomer: true })
    .returning();
  if (!contact) throw new Error('inbound create: failed to insert contact');

  await upsertLink(tx, {
    orgId: input.orgId,
    entityType: 'contact',
    localId: contact.id,
    qboType: 'Customer',
    qboId: qboCustomerId,
    state: 'synced',
    lastSyncedAt: new Date(),
  });
  await writeAuditLog(tx, {
    orgId: input.orgId,
    userId: null,
    entityType: 'contact',
    localId: contact.id,
    action: 'qbo.inbound.link',
    direction: 'inbound',
    outcome: 'success',
    triggeringEvent: `${input.realmId}:${input.entity.name}:${input.entity.id}:${input.entity.operation}`,
    detail: { matchedBy: 'customer_ref', qboCustomerId },
  });
  return contact.id;
}

/**
 * Inbound CREATE (30016): materializes a local `customer_invoice` from the refetched QBO state when
 * a webhook references a QBO invoice with no local link and no natural-key match. Resolves/creates
 * the contact from `CustomerRef`, maps the sales lines, posts the balanced ledger via the shared
 * `insertCustomerInvoice`, then writes the `sync_links` row keyed to the QBO id so it's linked from
 * then on. Idempotency: the webhook route dedups a byte-identical redelivery (event-dedup), and a
 * later distinct event for the same QBO id finds the link created here (`findLinkByQbo`) and takes
 * the normal linked-update path — the `(orgId, qboType, qboId)` unique makes a racing double-create
 * fail its link write and roll the whole apply back, so the event is re-driven, never duplicated.
 */
async function createLocalInvoiceFromQbo(
  tx: Tx,
  input: ApplyInboundEntityInput,
  qbo: Record<string, unknown>,
): Promise<InboundResult> {
  const lines = mapQboInvoiceLines(qbo);
  if (lines.length === 0) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: 'inbound_create_no_lines',
    });
    return { action: 'skipped', reason: 'inbound_create_no_lines' };
  }

  const contactId = await resolveOrCreateContactFromRef(tx, input, qbo);
  if (!contactId) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: 'inbound_create_no_customer_ref',
    });
    return { action: 'skipped', reason: 'inbound_create_no_customer_ref' };
  }

  const { txn } = await insertCustomerInvoice(tx, input.orgId, {
    contactId,
    txnDate: typeof qbo.TxnDate === 'string' ? qbo.TxnDate : new Date().toISOString().slice(0, 10),
    dueDate: typeof qbo.DueDate === 'string' ? qbo.DueDate : null,
    memo: typeof qbo.PrivateNote === 'string' ? qbo.PrivateNote : null,
    docNumber: typeof qbo.DocNumber === 'string' ? qbo.DocNumber : null,
    lines,
    createdBy: null,
  });

  await upsertLink(tx, {
    orgId: input.orgId,
    entityType: 'transaction',
    localId: txn.id,
    qboType: 'Invoice',
    qboId: input.entity.id,
    state: 'synced',
    localVersion: txn.version,
    qboSyncToken: qboSyncToken(qbo) ?? null,
    lastSyncedAt: new Date(),
  });

  await audit(tx, input, txn.id, 'qbo.inbound.create', 'success', {
    contactId,
    lineCount: lines.length,
    total: txn.total,
  });
  return { action: 'created', localId: txn.id };
}

async function applyInvoice(tx: Tx, input: ApplyInboundEntityInput): Promise<InboundResult> {
  const qbo = unwrapEntity(input.refetched, 'Invoice') as Record<string, unknown> | undefined;
  if (!qbo || typeof qbo !== 'object') {
    await audit(tx, input, null, 'qbo.inbound.skip', 'failure', {
      reason: 'refetch_missing_entity_body',
    });
    return { action: 'skipped', reason: 'refetch_missing_entity_body' };
  }

  const link = await findLinkByQbo(tx, input.orgId, 'Invoice', input.entity.id);
  if (link) return applyLinkedInvoice(tx, input, link, qbo);
  return linkUnmatchedInvoice(tx, input, qbo);
}

// ---------------------------------------------------------------------------
// Payment apply.
// ---------------------------------------------------------------------------

/** Recomputes an invoice's `status`/`balance` from its current `payment_applications` after one
 * of its payments changed. Mirrors `payments/service.ts`'s private `recomputeInvoice` — kept as a
 * small local copy here rather than exported/reused from that module, since the two contexts
 * differ (this one has no `PaymentContext`/user actor; it's a system-initiated recompute inside
 * the inbound tx and writes its own `qbo.inbound.*` audit rather than a `payment`/`void` one). */
async function recomputeLocalInvoiceBalance(
  tx: Tx,
  orgId: string,
  invoiceId: string,
): Promise<void> {
  const [invoice] = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.orgId, orgId),
        eq(transactions.id, invoiceId),
        eq(transactions.type, 'customer_invoice'),
      ),
    )
    .limit(1);
  if (!invoice) return;

  const paidCents = await sumAppliedPaymentsCents(tx, orgId, invoiceId);
  const totalCents = toCents(invoice.total);
  const status = deriveInvoiceStatus(totalCents, paidCents);

  const [updated] = await tx
    .update(transactions)
    .set({
      status,
      balance: formatCents(totalCents - Math.min(paidCents, totalCents)),
      version: sql`${transactions.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(transactions.orgId, orgId),
        eq(transactions.id, invoiceId),
        eq(transactions.version, invoice.version),
      ),
    )
    .returning();
  // 30022: this runs inside the caller's inbound webhook/retry-sweep transaction (see the module
  // doc comment, decision #1) — an uncaught throw here rolls back the whole tx safely, so a plain
  // Error is enough (no route-facing typed class needed, matching this function's existing
  // no-typed-error style).
  if (!updated) throw new Error('invoice version changed during inbound payment recompute');

  // Keeps the invoice's own link dirty/clean signal unaffected by this version bump — see
  // `bumpLocalVersion`'s doc comment. Only the invoice's own link, never the payment's.
  await bumpLocalVersion(tx, orgId, 'transaction', invoiceId);
}

async function applyLinkedPayment(
  tx: Tx,
  input: ApplyInboundEntityInput,
  link: SyncLinkRow,
  qbo: Record<string, unknown>,
): Promise<InboundResult> {
  const localId = link.localId;
  const [existing] = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.orgId, input.orgId),
        eq(transactions.id, localId),
        eq(transactions.type, 'payment'),
      ),
    )
    .limit(1);
  if (!existing) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: 'linked_local_row_missing',
    });
    return { action: 'skipped', reason: 'linked_local_row_missing' };
  }

  // Terminal state (20009 §0a.5) — see the matching check in `applyLinkedInvoice`.
  if (existing.deletedAt) {
    await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
      reason: 'already_deleted',
    });
    return { action: 'skipped', localId: existing.id, reason: 'already_deleted' };
  }

  const held = await handleAlreadyConflictHold(tx, input, link, existing, qbo);
  if (held) return held;

  if (DELETE_OPERATIONS.has(input.entity.operation)) {
    if (!input.bypassConflict && isLinkStale(link, qbo)) {
      await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
        reason: 'stale_ignored',
      });
      return { action: 'skipped', localId: existing.id, reason: 'stale_ignored' };
    }
    // 20010: same both-sides-changed check as the invoice path, before any mutation — catches
    // the deleted-in-both case (a local payment edited/voided while QBO also deletes it) instead
    // of silently deleting `payment_applications` out from under a conflicting local edit.
    const conflict = await handleConflictIfAny(tx, input, link, existing, qbo);
    if (conflict) return conflict;

    const applications = await tx
      .select()
      .from(paymentApplications)
      .where(
        and(
          eq(paymentApplications.orgId, input.orgId),
          eq(paymentApplications.paymentTxnId, existing.id),
        ),
      );

    await zeroOutLedger(tx, {
      orgId: input.orgId,
      transactionId: existing.id,
      entryDate: existing.txnDate,
      contactId: existing.contactId,
    });
    if (applications.length > 0) {
      await tx
        .delete(paymentApplications)
        .where(
          and(
            eq(paymentApplications.orgId, input.orgId),
            eq(paymentApplications.paymentTxnId, existing.id),
          ),
        );
    }
    await tx
      .update(transactions)
      .set({ deletedAt: new Date(), version: existing.version + 1, updatedAt: new Date() })
      .where(and(eq(transactions.orgId, input.orgId), eq(transactions.id, existing.id)));

    for (const application of applications) {
      await recomputeLocalInvoiceBalance(tx, input.orgId, application.invoiceTxnId);
    }

    await markSynced(tx, input.orgId, 'transaction', existing.id, {
      qboSyncToken: qboSyncToken(qbo),
      localVersion: existing.version + 1,
      lastSyncedAt: new Date(),
    });
    await audit(tx, input, existing.id, 'qbo.inbound.delete', 'success', {
      invoiceIds: applications.map((a) => a.invoiceTxnId),
    });
    return { action: 'deleted', localId: existing.id };
  }

  if (VOID_OPERATIONS.has(input.entity.operation)) {
    if (existing.status === 'void') {
      await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
        reason: 'already_void',
      });
      return { action: 'skipped', localId: existing.id, reason: 'already_void' };
    }
    if (!input.bypassConflict && isLinkStale(link, qbo)) {
      await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
        reason: 'stale_ignored',
      });
      return { action: 'skipped', localId: existing.id, reason: 'stale_ignored' };
    }
    // 20010: same both-sides-changed check as the invoice Void branch — catches the voided-in-
    // both case for payments before `payment_applications` is torn down.
    const conflict = await handleConflictIfAny(tx, input, link, existing, qbo);
    if (conflict) return conflict;

    const applications = await tx
      .select()
      .from(paymentApplications)
      .where(
        and(
          eq(paymentApplications.orgId, input.orgId),
          eq(paymentApplications.paymentTxnId, existing.id),
        ),
      );

    await zeroOutLedger(tx, {
      orgId: input.orgId,
      transactionId: existing.id,
      entryDate: existing.txnDate,
      contactId: existing.contactId,
    });
    if (applications.length > 0) {
      await tx
        .delete(paymentApplications)
        .where(
          and(
            eq(paymentApplications.orgId, input.orgId),
            eq(paymentApplications.paymentTxnId, existing.id),
          ),
        );
    }
    await tx
      .update(transactions)
      .set({ status: 'void', version: existing.version + 1, updatedAt: new Date() })
      .where(and(eq(transactions.orgId, input.orgId), eq(transactions.id, existing.id)));

    for (const application of applications) {
      await recomputeLocalInvoiceBalance(tx, input.orgId, application.invoiceTxnId);
    }

    await markSynced(tx, input.orgId, 'transaction', existing.id, {
      qboSyncToken: qboSyncToken(qbo),
      localVersion: existing.version + 1,
      lastSyncedAt: new Date(),
    });
    await audit(tx, input, existing.id, 'qbo.inbound.void', 'success', {
      invoiceIds: applications.map((a) => a.invoiceTxnId),
    });
    return { action: 'voided', localId: existing.id };
  }

  if (existing.status === 'void') {
    await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
      reason: 'local_already_void_no_unvoid',
    });
    return { action: 'skipped', localId: existing.id, reason: 'local_already_void_no_unvoid' };
  }

  if (!input.bypassConflict && isLinkStale(link, qbo)) {
    await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
      reason: 'stale_ignored',
    });
    return { action: 'skipped', localId: existing.id, reason: 'stale_ignored' };
  }

  const conflict = await handleConflictIfAny(tx, input, link, existing, qbo);
  if (conflict) return conflict;

  const patch = qboPaymentToLocalPatch(qbo);
  await tx
    .update(transactions)
    .set({
      txnDate: patch.txnDate ?? existing.txnDate,
      memo: patch.memo !== undefined ? patch.memo : existing.memo,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.orgId, input.orgId), eq(transactions.id, existing.id)));

  await markSynced(tx, input.orgId, 'transaction', existing.id, {
    qboSyncToken: qboSyncToken(qbo),
    localVersion: existing.version + 1,
    lastSyncedAt: new Date(),
  });
  await audit(tx, input, existing.id, 'qbo.inbound.update', 'success', {
    fields: Object.keys(patch),
  });
  return { action: 'updated', localId: existing.id };
}

/**
 * Inbound Payment CREATE: materializes a local `payment` from the refetched QBO state when a
 * webhook references a QBO Payment with no local link. Mirrors `createLocalInvoiceFromQbo`'s
 * shape, but there's no natural-key matcher for Payment (20004 only built Contact/Invoice
 * matchers) to fall back to first — every unlinked Payment goes straight through this path.
 * **Every invoice a payment applies to must already be linked locally** — never guessed, never
 * partially imported: if any `LinkedTxn` resolves to an invoice QBO id `sync_links` doesn't know
 * about yet, the whole import is skipped (that invoice hasn't synced in either direction yet, so
 * there's nothing local to apply the payment against). Posts one aggregate debit-deposit /
 * credit-A/R ledger line pair for the payment's total (mirroring `payments/service.ts`'s
 * `recordPayment`), one `payment_applications` row per resolved line, and recomputes every
 * affected invoice's `status`/`balance` via the existing `recomputeLocalInvoiceBalance`. Idempotent
 * the same way `createLocalInvoiceFromQbo` is: event-dedup catches byte-identical redelivery, a
 * later distinct event for the same QBO id finds the link this creates and takes the linked-update
 * path, and the `(orgId, qboType, qboId)` unique rolls back a racing double-create.
 */
async function createLocalPaymentFromQbo(
  tx: Tx,
  input: ApplyInboundEntityInput,
  qbo: Record<string, unknown>,
): Promise<InboundResult> {
  const lines = qboPaymentToLocalLines(qbo);
  if (lines.length === 0) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: 'inbound_payment_no_linked_invoices',
    });
    return { action: 'skipped', reason: 'inbound_payment_no_linked_invoices' };
  }

  const invoiceIds: string[] = [];
  for (const line of lines) {
    const invoiceLink = await findLinkByQbo(tx, input.orgId, 'Invoice', line.invoiceQboId);
    if (!invoiceLink) {
      await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
        reason: 'inbound_payment_unresolved_invoice',
        qboInvoiceId: line.invoiceQboId,
      });
      return { action: 'skipped', reason: 'inbound_payment_unresolved_invoice' };
    }
    invoiceIds.push(invoiceLink.localId);
  }

  const contactId = await resolveOrCreateContactFromRef(tx, input, qbo);
  if (!contactId) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: 'inbound_create_no_customer_ref',
    });
    return { action: 'skipped', reason: 'inbound_create_no_customer_ref' };
  }

  const ar = await getAccountBySubtype(tx, input.orgId, 'accounts_receivable');
  const undeposited = await getAccountBySubtype(tx, input.orgId, 'undeposited_funds');
  if (!ar || !undeposited) {
    throw new Error(
      `qbo inbound payment create: chart of accounts not seeded for org ${input.orgId}`,
    );
  }

  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const txnDate =
    typeof qbo.TxnDate === 'string' ? qbo.TxnDate : new Date().toISOString().slice(0, 10);

  const [paymentRow] = await tx
    .insert(transactions)
    .values({
      orgId: input.orgId,
      type: 'payment',
      status: 'paid',
      contactId,
      txnDate,
      memo: typeof qbo.PrivateNote === 'string' ? qbo.PrivateNote : null,
      subtotal: formatCents(totalCents),
      total: formatCents(totalCents),
      balance: '0.00',
      version: 0,
      createdBy: null,
    })
    .returning();
  if (!paymentRow) throw new Error('inbound payment create: failed to insert transaction');

  await tx.insert(paymentApplications).values(
    lines.map((line, index) => ({
      orgId: input.orgId,
      paymentTxnId: paymentRow.id,
      invoiceTxnId: invoiceIds[index],
      amount: formatCents(line.amountCents),
    })),
  );

  await postLedger(tx, {
    orgId: input.orgId,
    transactionId: paymentRow.id,
    entryDate: txnDate,
    lines: [
      { accountId: undeposited.id, contactId, debit: formatCents(totalCents) },
      { accountId: ar.id, contactId, credit: formatCents(totalCents) },
    ],
  });

  // A QBO payment could in principle list the same invoice on more than one line — recompute is
  // idempotent per id, so a defensive `Set` just avoids redundant work, not incorrect results.
  const uniqueInvoiceIds = [...new Set(invoiceIds)];
  for (const invoiceId of uniqueInvoiceIds) {
    await recomputeLocalInvoiceBalance(tx, input.orgId, invoiceId);
  }

  await upsertLink(tx, {
    orgId: input.orgId,
    entityType: 'transaction',
    localId: paymentRow.id,
    qboType: 'Payment',
    qboId: input.entity.id,
    state: 'synced',
    localVersion: paymentRow.version,
    qboSyncToken: qboSyncToken(qbo) ?? null,
    lastSyncedAt: new Date(),
  });

  await audit(tx, input, paymentRow.id, 'qbo.inbound.create', 'success', {
    contactId,
    invoiceIds: uniqueInvoiceIds,
    total: paymentRow.total,
  });
  return { action: 'created', localId: paymentRow.id };
}

async function applyPayment(tx: Tx, input: ApplyInboundEntityInput): Promise<InboundResult> {
  const qbo = unwrapEntity(input.refetched, 'Payment') as Record<string, unknown> | undefined;
  if (!qbo || typeof qbo !== 'object') {
    await audit(tx, input, null, 'qbo.inbound.skip', 'failure', {
      reason: 'refetch_missing_entity_body',
    });
    return { action: 'skipped', reason: 'refetch_missing_entity_body' };
  }

  const link = await findLinkByQbo(tx, input.orgId, 'Payment', input.entity.id);
  if (link) return applyLinkedPayment(tx, input, link, qbo);

  if (VOID_OR_DELETE_OPERATIONS.has(input.entity.operation)) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: 'unlinked_nothing_to_void',
    });
    return { action: 'skipped', reason: 'unlinked_nothing_to_void' };
  }

  // No natural-key matcher exists for Payment (20004 only built Contact/Invoice matchers), so
  // there's no "link the existing pair" step to try first — an unlinked Payment is IMPORTED
  // directly (mirrors 30016's inbound Invoice import), as long as every invoice it applies to is
  // already linked locally.
  return createLocalPaymentFromQbo(tx, input, qbo);
}

// ---------------------------------------------------------------------------
// Customer apply (linking only — content isn't patched inbound, see decision #2/module scope).
// ---------------------------------------------------------------------------

async function applyCustomer(tx: Tx, input: ApplyInboundEntityInput): Promise<InboundResult> {
  const qbo = unwrapEntity(input.refetched, 'Customer') as Record<string, unknown> | undefined;
  if (!qbo || typeof qbo !== 'object') {
    await audit(tx, input, null, 'qbo.inbound.skip', 'failure', {
      reason: 'refetch_missing_entity_body',
    });
    return { action: 'skipped', reason: 'refetch_missing_entity_body' };
  }

  const link = await findLinkByQbo(tx, input.orgId, 'Customer', input.entity.id);
  if (link) {
    if (VOID_OR_DELETE_OPERATIONS.has(input.entity.operation)) {
      // A Contact has no void OR delete state locally — a QBO customer delete/void has nothing
      // to apply either way (unlike Invoice/Payment, Customer never splits the two).
      await audit(tx, input, link.localId, 'qbo.inbound.skip', 'skipped', {
        reason: 'contact_void_not_supported',
      });
      return { action: 'skipped', localId: link.localId, reason: 'contact_void_not_supported' };
    }

    // Customer *content* sync is out of scope here (plan §0a.2 keeps apply to Invoice+Payment,
    // Customer is linking-only) — refresh the link's SyncToken so later tasks see the latest,
    // but don't patch the Contact row itself.
    await markSynced(tx, input.orgId, 'contact', link.localId, {
      qboSyncToken: qboSyncToken(qbo),
      lastSyncedAt: new Date(),
    });
    await audit(tx, input, link.localId, 'qbo.inbound.update', 'success', {
      reason: 'link_refreshed_content_not_applied',
    });
    return { action: 'updated', localId: link.localId };
  }

  if (VOID_OR_DELETE_OPERATIONS.has(input.entity.operation)) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: 'unlinked_nothing_to_void',
    });
    return { action: 'skipped', reason: 'unlinked_nothing_to_void' };
  }

  const target = qboCustomerToMatchTarget(qbo);
  const candidateRows = await loadContactCandidates(tx, input.orgId);
  const result = matchContactByNaturalKey(target, asQboCustomerLike(candidateRows));

  if (result.kind !== 'match') {
    const reason =
      result.kind === 'ambiguous'
        ? 'ambiguous_natural_key_match'
        : input.entity.operation === 'Create'
          ? 'no_match:create_deferred'
          : 'no_match';
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason,
      candidateCount: result.kind === 'ambiguous' ? result.candidates.length : 0,
    });
    return { action: 'unmatched', reason };
  }

  // `result.qboId` is our aliased local id — see `asQboCustomerLike`.
  const localId = result.qboId;
  await upsertLink(tx, {
    orgId: input.orgId,
    entityType: 'contact',
    localId,
    qboType: 'Customer',
    qboId: input.entity.id,
    state: 'synced',
    qboSyncToken: qboSyncToken(qbo) ?? null,
    lastSyncedAt: new Date(),
  });
  await audit(tx, input, localId, 'qbo.inbound.link', 'success', { matchedBy: 'natural_key' });
  return { action: 'linked', localId };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Applies one already-refetched, already-claimed (via `recordEventIfNew`) webhook entity to the
 * internal domain. Must be called with the SAME `tx` the caller used for `recordEventIfNew` — see
 * decision #1. Never throws for an expected business condition (missing local row, ambiguous
 * match, unsupported entity type/operation) — those are all `skipped`/`unmatched` results with an
 * audit row. A thrown error here means something unexpected (e.g. a real DB error), and the
 * caller's `db.transaction` will roll back both this apply AND the `recordEventIfNew` claim,
 * which is exactly the intended "never claim a half-applied event" behavior.
 */
export async function applyInboundEntity(
  tx: Tx,
  input: ApplyInboundEntityInput,
): Promise<InboundResult> {
  if (NOOP_OPERATIONS.has(input.entity.operation)) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: `operation_not_applied:${input.entity.operation}`,
    });
    return { action: 'skipped', reason: `operation_not_applied:${input.entity.operation}` };
  }

  if (input.entityType === 'Invoice') return applyInvoice(tx, input);
  if (input.entityType === 'Payment') return applyPayment(tx, input);
  if (input.entityType === 'Customer') return applyCustomer(tx, input);

  // Account / Item (or any future notification type `mapNotificationToEntityType` accepts):
  // apply is scoped to Invoice + Payment + Customer-linking (plan §5) — everything else is a
  // recorded no-op so it never drops silently.
  await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
    reason: `entity_type_not_applied:${input.entityType}`,
  });
  return { action: 'skipped', reason: `entity_type_not_applied:${input.entityType}` };
}
