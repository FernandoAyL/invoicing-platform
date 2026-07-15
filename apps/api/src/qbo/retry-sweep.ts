// Outbound retry sweep (20011, docs/design-decisions.md ## Failure handling,
// `.claude/plans/20011-failure-handling.md`). Re-drives `failed` sync_links whose backoff has
// elapsed, reusing the exact `syncInvoiceOutbound`/`syncPaymentOutbound`/`ensureEntitySynced`
// machinery every other outbound push goes through (never forked) — this module adds only:
//   1. "which links are due" selection (`findFailedLinksDue`).
//   2. The reconcile-before-create safety check for a genuine first-time CREATE (§0a.5): a write
//      that timed out may have landed at QBO even though the local link write never happened —
//      blindly re-creating would duplicate a financial record. QBO has no request-idempotency key
//      (`idempotency-key.ts` is audit-only), so this is a natural-key query + match instead.
//   3. A thin per-org orchestrator, and the manual-retry entry point `retryOneFailedLink` shared
//      by both the sweep and `routes/sync-failures.ts`.
//
// Runtime note: nothing in this file starts a timer. The only `setInterval` in the whole app is
// in `index.ts` (never `app.ts`, so `buildApp()`/tests never spawn one) — see §0a.7.

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { writeAuditLog } from '../audit/service.ts';
import type * as schema from '../db/schema.ts';
import { contacts, transactions } from '../db/schema.ts';
import type { QboEntityType } from './api-client.ts';
import {
  type LocalContactLike,
  type LocalInvoiceLike,
  matchContactByNaturalKey,
  matchInvoiceByNaturalKey,
  type QboCustomerLike,
  type QboInvoiceLike,
} from './natural-key.ts';
import type { QboOAuthClient } from './oauth-client.ts';
import {
  ensureEntitySynced,
  type OutboundDeps,
  type QboWriteClient,
  resolveOutboundDeps,
  syncInvoiceOutbound,
  syncPaymentOutbound,
} from './outbound-sync.ts';
import {
  deleteNeverSyncedFailedLink,
  findFailedLinksDue,
  findLinkByLocal,
  markFailed,
  type SyncLinkRow,
  upsertLink,
} from './sync-link-service.ts';

type Db = NodePgDatabase<typeof schema>;

export interface RetrySweepClients {
  oauthClient: QboOAuthClient | null;
  apiClient: QboWriteClient | null;
}

export interface RetrySweepSummary {
  retried: number;
  succeeded: number;
  failed: number;
  terminal: number;
  /** 20011 code-review fix: a never-synced (`qboId` null) link whose local txn turned out to
   * already be terminal (soft-deleted/voided) — removed from the retry queue entirely rather
   * than left to loop forever. Counted separately from `succeeded` (nothing was actually synced)
   * and `failed`/`terminal` (the link no longer exists at all, not merely exhausted). */
  cleared: number;
}

export type RetryOutcome = 'succeeded' | 'failed' | 'terminal' | 'cleared';

// QBO's query API (developer.intuit.com/app/developer/qbo/docs/develop/sql-query-syntax) has no
// parameterized-query mechanism — string literals in a WHERE clause are escaped, not bound. Per
// Intuit's documented rule a literal backslash and a literal single quote must each be escaped
// with a preceding backslash. Order matters: backslash-escaping MUST run first, or a backslash
// introduced by the quote-escaping step would itself get doubled by a subsequent backslash pass.
export function escapeQboString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Pure, exported so adversarial input (embedded quotes/backslashes) can be tested without
 * needing to smuggle it through a real DB round-trip — `txn.txnDate`'s actual column type
 * (Postgres `date`) makes that impossible for the TxnDate branch specifically. */
export function buildDocumentCreateWhere(txn: {
  docNumber: string | null;
  txnDate: string;
}): string {
  return txn.docNumber
    ? `DocNumber = '${escapeQboString(txn.docNumber)}'`
    : `TxnDate = '${escapeQboString(txn.txnDate)}'`;
}

export function buildContactCreateWhere(contact: {
  email: string | null;
  displayName: string;
}): string {
  return contact.email
    ? `PrimaryEmailAddr.Address = '${escapeQboString(contact.email)}'`
    : `DisplayName = '${escapeQboString(contact.displayName)}'`;
}

/**
 * Reconciles a genuine CREATE retry (`link.qboId === null`) against QBO by natural key before
 * letting `syncInvoiceOutbound`/`syncPaymentOutbound` issue a real create (§0a.5). Returns:
 *  - `'linked'` — a confident single match was found; the link now points at it (`upsertLink`
 *    with `state: 'synced'`) and the caller must NOT also create.
 *  - `'none'` — no match (or no query capability / the query itself failed) — safe to proceed
 *    with a genuine create.
 *  - `'ambiguous'` — more than one candidate matched; per `natural-key.ts` philosophy this is
 *    never auto-linked — the caller marks the link failed again for a human to resolve via
 *    `GET /api/sync/failures`.
 *
 * Reused for both Invoice and Payment: `matchInvoiceByNaturalKey`'s fields (docNumber/total/
 * txnDate/customerQboId) are generic "document" natural-key fields, not Invoice-specific — a QBO
 * Payment has the same shape (no natural-key matcher exists specifically for payments, and this
 * task's locked decisions name only the invoice/contact matchers already in `natural-key.ts`).
 */
async function reconcileDocumentCreate(
  db: Db,
  deps: OutboundDeps,
  link: SyncLinkRow,
  txn: typeof transactions.$inferSelect,
): Promise<'linked' | 'none' | 'ambiguous'> {
  if (!deps.client.queryEntities) return 'none';

  const contactLink = txn.contactId
    ? await findLinkByLocal(db, link.orgId, 'contact', txn.contactId)
    : null;
  const customerQboId = contactLink?.qboId ?? null;

  const where = buildDocumentCreateWhere(txn);

  let candidates: Record<string, unknown>[];
  try {
    candidates = await deps.client.queryEntities({
      realmId: deps.realmId,
      accessToken: deps.accessToken,
      entityType: link.qboType as QboEntityType,
      where,
    });
  } catch {
    return 'none'; // the query itself failed -> fall back to attempting the create.
  }

  const local: LocalInvoiceLike = {
    docNumber: txn.docNumber,
    total: txn.total,
    txnDate: txn.txnDate,
    customerQboId,
  };
  const qboCandidates: QboInvoiceLike[] = candidates.map((c) => ({
    qboId: String(c.Id),
    docNumber: (c.DocNumber as string | null | undefined) ?? null,
    total: String(c.TotalAmt ?? '0'),
    txnDate: String(c.TxnDate ?? ''),
    customerQboId: (c.CustomerRef as { value?: string } | undefined)?.value ?? null,
  }));

  const match = matchInvoiceByNaturalKey(local, qboCandidates);
  if (match.kind === 'none') return 'none';
  if (match.kind === 'ambiguous') return 'ambiguous';

  const found = candidates.find((c) => String(c.Id) === match.qboId);
  await upsertLink(db, {
    orgId: link.orgId,
    entityType: 'transaction',
    localId: txn.id,
    qboType: link.qboType,
    qboId: match.qboId,
    state: 'synced',
    localVersion: txn.version,
    qboSyncToken: (found?.SyncToken as string | undefined) ?? null,
    lastSyncedAt: new Date(),
    conflictDetectedAt: null,
    retryCount: 0,
    nextRetryAt: null,
    lastError: null,
  });
  await writeAuditLog(db, {
    orgId: link.orgId,
    userId: null,
    entityType: 'transaction',
    localId: txn.id,
    action: 'outbound_sync',
    direction: 'outbound',
    outcome: 'success',
    detail: { qboType: link.qboType, qboId: match.qboId, reason: 'reconciled_existing_qbo_record' },
  });
  return 'linked';
}

/** Same idea as `reconcileDocumentCreate`, for a `contact` ref link. Account/item refs have no
 * natural-key matcher in `natural-key.ts` (out of this task's named scope) and are retried as a
 * plain create via `ensureEntitySynced` with no reconciliation step. */
async function reconcileContactCreate(
  db: Db,
  deps: OutboundDeps,
  link: SyncLinkRow,
  contact: { id: string; displayName: string; email: string | null },
): Promise<'linked' | 'none' | 'ambiguous'> {
  if (!deps.client.queryEntities) return 'none';

  const where = buildContactCreateWhere(contact);

  let candidates: Record<string, unknown>[];
  try {
    candidates = await deps.client.queryEntities({
      realmId: deps.realmId,
      accessToken: deps.accessToken,
      entityType: 'Customer',
      where,
    });
  } catch {
    return 'none';
  }

  const local: LocalContactLike = { displayName: contact.displayName, email: contact.email };
  const qboCandidates: QboCustomerLike[] = candidates.map((c) => ({
    qboId: String(c.Id),
    email:
      (c.PrimaryEmailAddr as { Address?: string } | undefined)?.Address ??
      (c.email as string | undefined) ??
      null,
    displayName: (c.DisplayName as string | null | undefined) ?? null,
  }));

  const match = matchContactByNaturalKey(local, qboCandidates);
  if (match.kind === 'none') return 'none';
  if (match.kind === 'ambiguous') return 'ambiguous';

  const found = candidates.find((c) => String(c.Id) === match.qboId);
  await upsertLink(db, {
    orgId: link.orgId,
    entityType: 'contact',
    localId: contact.id,
    qboType: 'Customer',
    qboId: match.qboId,
    state: 'synced',
    qboSyncToken: (found?.SyncToken as string | undefined) ?? null,
    lastSyncedAt: new Date(),
    retryCount: 0,
    nextRetryAt: null,
    lastError: null,
  });
  await writeAuditLog(db, {
    orgId: link.orgId,
    userId: null,
    entityType: 'contact',
    localId: contact.id,
    action: 'outbound_sync',
    direction: 'outbound',
    outcome: 'success',
    detail: { qboType: 'Customer', qboId: match.qboId, reason: 'reconciled_existing_qbo_record' },
  });
  return 'linked';
}

async function retryTransactionLink(db: Db, deps: OutboundDeps, link: SyncLinkRow): Promise<void> {
  const [txn] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.orgId, link.orgId), eq(transactions.id, link.localId)))
    .limit(1);
  if (!txn) {
    await markFailed(
      db,
      link.orgId,
      'transaction',
      link.localId,
      link.qboType,
      'retry: local transaction no longer exists',
    );
    return;
  }

  // Reconciliation only applies to a genuine CREATE (no qboId yet) of a live document — a
  // never-synced void/delete is already a no-op inside `voidDocument`/`deleteDocument` (nothing
  // remote to act on), so there's nothing to reconcile there either.
  if (!link.qboId && !txn.deletedAt && txn.status !== 'void') {
    const reconciled = await reconcileDocumentCreate(db, deps, link, txn);
    if (reconciled === 'linked') return;
    if (reconciled === 'ambiguous') {
      await markFailed(
        db,
        link.orgId,
        'transaction',
        txn.id,
        link.qboType,
        'ambiguous natural-key match during create-retry reconcile — resolve manually',
      );
      return;
    }
    // 'none' -> fall through to a genuine create below.
  }

  // 20011 code-review fix: a never-synced (`qboId` null) `failed` link whose local txn is
  // already terminal (soft-deleted or locally voided) is the one shape that must NOT just fall
  // through to `syncFn` and be left alone on a `skipped` result — `deleteDocument`/`voidDocument`
  // treat "never synced" as a no-op and never touch the link, so without this the link would be
  // re-selected by `findFailedLinksDue` every tick forever (never reaching terminal, never
  // resolvable via manual retry). Captured BEFORE the call since `syncFn` may itself flip
  // `link.qboId`'s row state (on the reconciled-elsewhere/create path above we already returned).
  const isNeverSyncedTerminalLocal =
    !link.qboId && (txn.deletedAt !== null || txn.status === 'void');

  const syncFn = link.qboType === 'Payment' ? syncPaymentOutbound : syncInvoiceOutbound;
  const result = await syncFn(db, deps, { orgId: link.orgId, txnId: txn.id, userId: null });

  if (isNeverSyncedTerminalLocal && result.status === 'skipped') {
    // Nothing ever reached QBO and the local record is now terminal — remove the link from the
    // retry queue entirely (never `markSynced`: a `synced` row with `qboId=null` would break
    // `ensureEntitySynced`'s `existing.state==='synced' && existing.qboId` gate and the
    // create-vs-update branch elsewhere).
    await deleteNeverSyncedFailedLink(db, link.orgId, 'transaction', txn.id);
  }
}

/** Only ever called for a ref link (`contact`/`account`/`item`) — `retryOneFailedLink` branches
 * on `entityType === 'transaction'` before choosing between this and `retryTransactionLink`. The
 * guard below is a runtime no-op (this should never actually throw) that exists purely to narrow
 * `link.entityType` for `ensureEntitySynced`, whose signature (correctly) excludes `'transaction'`
 * — a ref-only entry point, distinct from `retryTransactionLink`/`syncInvoiceOutbound`/
 * `syncPaymentOutbound`. */
async function retryRefLink(db: Db, deps: OutboundDeps, link: SyncLinkRow): Promise<void> {
  if (link.entityType === 'transaction') {
    throw new Error('unreachable: retryRefLink called for a transaction link');
  }

  if (link.entityType === 'contact' && !link.qboId) {
    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.orgId, link.orgId), eq(contacts.id, link.localId)))
      .limit(1);
    if (!contact) {
      await markFailed(
        db,
        link.orgId,
        'contact',
        link.localId,
        link.qboType,
        'retry: local contact no longer exists',
      );
      return;
    }
    const reconciled = await reconcileContactCreate(db, deps, link, contact);
    if (reconciled === 'linked') return;
    if (reconciled === 'ambiguous') {
      await markFailed(
        db,
        link.orgId,
        'contact',
        contact.id,
        link.qboType,
        'ambiguous natural-key match during create-retry reconcile — resolve manually',
      );
      return;
    }
  }

  // Account/item refs (no natural-key matcher), or a contact ref that already has a qboId (an
  // UPDATE-path failure) — reuse `ensureEntitySynced` directly; it already marks the link
  // failed + audits on a repeat failure, so nothing more to do in the catch here.
  try {
    await ensureEntitySynced(db, deps, link.orgId, link.entityType, link.localId);
  } catch {
    // already recorded by ensureEntitySynced's own catch.
  }
}

/**
 * Retries exactly one `failed` link, immediately — used by both the sweep (for links whose
 * backoff elapsed) and the manual-retry route (`POST /api/sync/failures/:linkId/retry`, which
 * forces an attempt regardless of `nextRetryAt`). Never throws: every sync path it delegates to
 * already turns a failure into a `failed` link + audit row internally; this function's job is
 * just to read the link's state back afterward and classify the outcome.
 */
export async function retryOneFailedLink(
  db: Db,
  deps: OutboundDeps,
  link: SyncLinkRow,
): Promise<RetryOutcome> {
  try {
    if (link.entityType === 'transaction') {
      await retryTransactionLink(db, deps, link);
    } else {
      await retryRefLink(db, deps, link);
    }
  } catch {
    // Any of the delegated sync functions already marked the link failed + audited on its own
    // failure path — nothing left to do here except fall through to reading the result back.
  }

  const updated = await findLinkByLocal(db, link.orgId, link.entityType, link.localId);
  // No row at all: either it never existed (shouldn't happen — `link` was just read moments ago)
  // or `retryTransactionLink` just cleared it via `deleteNeverSyncedFailedLink` (20011
  // code-review fix — a never-synced link whose local txn is now terminal/deleted-voided has
  // nothing left to retry and is removed from the queue rather than left to loop forever).
  if (!updated) return 'cleared';
  if (updated.state === 'synced') return 'succeeded';
  if (updated.state === 'failed' && updated.nextRetryAt === null) return 'terminal';
  return 'failed';
}

/**
 * Orchestrates the whole due-links sweep: selects every `failed` link whose `nextRetryAt` has
 * elapsed (cross-org), resolves each org's QBO connection once, and retries each link in turn. An
 * org with no QBO connection is skipped for this tick (its links stay `failed`, unchanged) — the
 * next tick tries again. Never throws: any per-link failure is already captured as a `failed`/
 * `terminal` outcome, not a rejected promise.
 */
export async function runOutboundRetrySweep(
  db: Db,
  clients: RetrySweepClients,
  now: Date,
): Promise<RetrySweepSummary> {
  const dueLinks = await findFailedLinksDue(db, now);
  const summary: RetrySweepSummary = {
    retried: 0,
    succeeded: 0,
    failed: 0,
    terminal: 0,
    cleared: 0,
  };

  const byOrg = new Map<string, SyncLinkRow[]>();
  for (const link of dueLinks) {
    const list = byOrg.get(link.orgId);
    if (list) list.push(link);
    else byOrg.set(link.orgId, [link]);
  }

  for (const [orgId, links] of byOrg) {
    const deps = await resolveOutboundDeps({
      db,
      oauthClient: clients.oauthClient,
      apiClient: clients.apiClient,
      orgId,
    });
    if (!deps) continue; // no connection -> skip, leave failed (retried again once reconnected).

    for (const link of links) {
      summary.retried += 1;
      const outcome = await retryOneFailedLink(db, deps, link);
      if (outcome === 'succeeded') summary.succeeded += 1;
      else if (outcome === 'terminal') summary.terminal += 1;
      else if (outcome === 'cleared') summary.cleared += 1;
      else summary.failed += 1;
    }
  }

  return summary;
}
