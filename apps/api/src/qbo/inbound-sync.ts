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
//   2. Apply matrix: linked + Update -> patch local; linked + Void/Delete -> void local (both
//      map to a local void here; delete-vs-void is 20009). Unlinked -> natural-key match
//      (Contacts for Customer, Invoices for Invoice); `match` -> link + apply, `ambiguous`/`none`
//      -> skipped audit, never auto-created/guessed.
//   3. Inbound CREATE of a brand-new local record is DEFERRED (not silent): a natural-key `none`
//      result is recorded as `skipped` "needs manual linking/creation" (20012 territory).
//   4. Content-update depth: scoped to invoice/payment METADATA (docNumber/txnDate/dueDate/memo)
//      + void/delete + payment status-effect-on-invoice-balance. Line/amount re-sync (re-posting
//      the ledger for a QBO-side line edit) is NOT implemented here — documented boundary, see
//      `docs/design-decisions.md` ## Idempotency. Because amounts are never touched by the
//      metadata path, the ledger is never put out of balance by it.
//   5. No ordering/stale-skip guard yet (20008): the refetched state is applied blindly
//      (last-value-wins). `markSynced` still records the QBO SyncToken + a local version so
//      20008/20010 have something to compare against.
//   6. Merge/Emailed operations -> no-op apply + skipped audit.

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { writeAuditLog } from '../audit/service.ts';
import type * as schema from '../db/schema.ts';
import { contacts, paymentApplications, syncLinks, transactions } from '../db/schema.ts';
import { zeroOutLedger } from '../ledger/posting.ts';
import { formatCents, toCents } from '../money.ts';
import { deriveInvoiceStatus } from '../payments/status.ts';
import { type QboEntityEnvelope, type QboEntityType, unwrapEntity } from './api-client.ts';
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
  findLinkByLocal,
  findLinkByQbo,
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

export type InboundAction = 'updated' | 'voided' | 'linked' | 'skipped' | 'unmatched';

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
}

const VOID_OPERATIONS = new Set(['Void', 'Delete']);
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

  if (VOID_OPERATIONS.has(input.entity.operation)) {
    if (existing.status === 'void') {
      await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
        reason: 'already_void',
      });
      return { action: 'skipped', localId: existing.id, reason: 'already_void' };
    }
    if (isLinkStale(link, qbo)) {
      await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
        reason: 'stale_ignored',
      });
      return { action: 'skipped', localId: existing.id, reason: 'stale_ignored' };
    }
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
    // Never un-void from an inbound update — proper conflict handling is 20010.
    await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
      reason: 'local_already_void_no_unvoid',
    });
    return { action: 'skipped', localId: existing.id, reason: 'local_already_void_no_unvoid' };
  }

  if (isLinkStale(link, qbo)) {
    await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
      reason: 'stale_ignored',
    });
    return { action: 'skipped', localId: existing.id, reason: 'stale_ignored' };
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
  if (VOID_OPERATIONS.has(input.entity.operation)) {
    await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
      reason: 'unlinked_nothing_to_void',
    });
    return { action: 'skipped', reason: 'unlinked_nothing_to_void' };
  }

  const target = qboInvoiceToMatchTarget(qbo);
  const candidateRows = await loadInvoiceCandidates(tx, input.orgId);
  const result = matchInvoiceByNaturalKey(target, asQboInvoiceLike(candidateRows));

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

  const applications = await tx
    .select()
    .from(paymentApplications)
    .where(
      and(eq(paymentApplications.orgId, orgId), eq(paymentApplications.invoiceTxnId, invoiceId)),
    );
  const paidCents = applications.reduce((sum, a) => sum + toCents(a.amount), 0);
  const totalCents = toCents(invoice.total);
  const status = deriveInvoiceStatus(totalCents, paidCents);

  await tx
    .update(transactions)
    .set({
      status,
      balance: formatCents(totalCents - Math.min(paidCents, totalCents)),
      version: invoice.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.orgId, orgId), eq(transactions.id, invoiceId)));
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

  if (VOID_OPERATIONS.has(input.entity.operation)) {
    if (existing.status === 'void') {
      await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
        reason: 'already_void',
      });
      return { action: 'skipped', localId: existing.id, reason: 'already_void' };
    }
    if (isLinkStale(link, qbo)) {
      await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
        reason: 'stale_ignored',
      });
      return { action: 'skipped', localId: existing.id, reason: 'stale_ignored' };
    }

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

  if (isLinkStale(link, qbo)) {
    await audit(tx, input, existing.id, 'qbo.inbound.skip', 'skipped', {
      reason: 'stale_ignored',
    });
    return { action: 'skipped', localId: existing.id, reason: 'stale_ignored' };
  }

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

  // No natural-key matcher exists for Payment (20004 only built Contact/Invoice matchers) — an
  // unlinked inbound Payment always needs manual linking. Documented scope boundary, never
  // guessed (see docs/design-decisions.md ## Mapping).
  await audit(tx, input, null, 'qbo.inbound.skip', 'skipped', {
    reason: 'no_payment_natural_key_matcher',
  });
  return { action: 'unmatched', reason: 'no_payment_natural_key_matcher' };
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
    if (VOID_OPERATIONS.has(input.entity.operation)) {
      // A Contact has no void state locally — a QBO customer delete/void has nothing to apply.
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

  if (VOID_OPERATIONS.has(input.entity.operation)) {
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
