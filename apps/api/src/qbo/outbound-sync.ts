// Outbound sync: propagates internal create/edit/void of invoices & payments to QBO. Called
// best-effort AFTER the domain mutation's own `db.transaction` has committed (never inside it —
// a QBO network call must never hold a local DB transaction open). Locked decisions (see
// `.claude/plans/20006-outbound-sync.md` §0a / `docs/design-decisions.md` ## Idempotency,
// ## Mapping):
//   1. Best-effort post-commit: outbound failure never rolls back or fails the local write/HTTP
//      response. On failure the matching `SyncLink` is set to `failed` + audited; the retry loop
//      over `failed` links is a separate task (20011).
//   2. Reference-data-first, `synced`-gated: every entity a document references (contact, each
//      distinct line account, each distinct line item) must have a `synced` SyncLink before the
//      document itself is pushed. A `pending`/`failed` ref link does not satisfy the gate.
//   3. Create-vs-update by existing link: a SyncLink with a `qboId` means UPDATE (sparse, with
//      the stored SyncToken), no link means CREATE — so a retried push is idempotent (update/
//      no-op, never a duplicate QBO record).
//   4. Void, not delete: a locally-voided invoice/payment syncs via QBO's void operation, which
//      keeps the record and zeroes amounts. A never-synced void is a no-op (nothing to void).
//   5. No connection = no-op: `resolveOutboundDeps` returns null and every push is skipped,
//      leaving the link `pending` and writing no audit failure.
//   6. Delete is distinct from void (20009, docs/design-decisions.md ## Delete vs void): a
//      locally-soft-deleted invoice/payment (`transactions.deletedAt` set) syncs via QBO's
//      `?operation=delete` instead of `?operation=void`. The entry points below check
//      `deletedAt` BEFORE `status === 'void'` so a voided-then-deleted document pushes a delete,
//      not a void. Same never-synced-is-a-no-op shape as void (nothing remote to delete).

import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { writeAuditLog } from '../audit/service.ts';
import { getContact } from '../contacts/service.ts';
import type * as schema from '../db/schema.ts';
import {
  accounts,
  items,
  paymentApplications,
  transactionLines,
  transactions,
} from '../db/schema.ts';
import { formatCents, toCents } from '../money.ts';
import { type QboApiClient, type QboEntityType, unwrapEntity } from './api-client.ts';
import { getValidAccessToken } from './connection-service.ts';
import { QboApiError, QboNotConnectedError } from './errors.ts';
import { outboundIdempotencyKey } from './idempotency-key.ts';
import type { QboOAuthClient } from './oauth-client.ts';
import {
  findLinkByLocal,
  markConflict,
  markFailed,
  markSynced,
  resolveQboType,
  type SyncEntityType,
  type SyncLinkRow,
  upsertLink,
} from './sync-link-service.ts';

type Db = NodePgDatabase<typeof schema>;

/** The write-capable QBO client (a superset of the read-only `QboApiClient`, extended in this
 * task with createEntity/updateEntity/voidEntity). Named separately here so call sites read as
 * "outbound needs a write client", even though today it's the same interface. */
export type QboWriteClient = QboApiClient;

/** Everything a push needs, resolved once per request/job by `resolveOutboundDeps`. */
export interface OutboundDeps {
  client: QboWriteClient;
  realmId: string;
  accessToken: string;
}

export type OutboundStatus = 'synced' | 'failed' | 'skipped';

export interface OutboundResult {
  status: OutboundStatus;
  qboId?: string;
  reason?: string;
}

export interface OutboundParams {
  orgId: string;
  txnId: string;
  /** The user whose action triggered this push, for the audit trail. Null for
   * system/cron-triggered pushes (none exist yet — everything today is route-triggered). */
  userId?: string | null;
  /** 20010: set only by the conflict-resolution route's `winner:'local'` path — the user has
   * explicitly chosen the local version to win, so both the `conflict_blocked` guard below and
   * the `already_current` redundant-write guard are bypassed and the push always goes out. Never
   * set by any other caller. */
  force?: boolean;
}

export interface ResolveOutboundDepsInput {
  db: Db;
  oauthClient: QboOAuthClient | null;
  apiClient: QboWriteClient | null;
  orgId: string;
}

/**
 * Resolves the deps a push needs, or `null` when outbound sync should be a no-op: no QBO client
 * configured, or the org has no QBO connection. Never throws for "not connected" — that's the
 * expected no-op path (decision #5), not an error. Any other failure while refreshing the access
 * token (e.g. the refresh token itself was revoked) is also treated as "not connected" here,
 * since from the caller's point of view both mean "can't push right now".
 */
export async function resolveOutboundDeps(
  input: ResolveOutboundDepsInput,
): Promise<OutboundDeps | null> {
  if (!input.apiClient || !input.oauthClient) return null;

  try {
    const { accessToken, realmId } = await getValidAccessToken(
      input.db,
      input.oauthClient,
      input.orgId,
    );
    return { client: input.apiClient, realmId, accessToken };
  } catch (err) {
    if (err instanceof QboNotConnectedError) return null;
    throw err;
  }
}

function dollars(cents: number): number {
  return Number(formatCents(cents));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Pure QBO payload builders. Each returns the "create" shape; `pushEntity` (below) layers
// `Id`/`SyncToken`/`sparse: true` on top for an update — payload builders never need to know
// whether they're building a create or an update.
// ---------------------------------------------------------------------------

export interface QboCustomerSource {
  displayName: string;
  email: string | null;
  phone: string | null;
}

export function buildQboCustomer(contact: QboCustomerSource): Record<string, unknown> {
  const body: Record<string, unknown> = { DisplayName: contact.displayName };
  if (contact.email) body.PrimaryEmailAddr = { Address: contact.email };
  if (contact.phone) body.PrimaryPhone = { FreeFormNumber: contact.phone };
  return body;
}

export interface QboAccountSource {
  name: string;
  type: string;
  subtype: string | null;
}

// Local `account_type` -> QBO `AccountType`. Deliberately coarse (this is a minimal write
// client, not a faithful chart-of-accounts mapper) — subtype overrides catch the few local
// subtypes this codebase actually seeds (accounts_receivable, undeposited_funds, sales_income).
const ACCOUNT_TYPE_TO_QBO: Record<string, string> = {
  asset: 'Other Current Asset',
  liability: 'Other Current Liability',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expense',
};

const SUBTYPE_TO_QBO_ACCOUNT_TYPE: Record<string, string> = {
  accounts_receivable: 'Accounts Receivable',
  undeposited_funds: 'Other Current Asset',
  sales_income: 'Income',
};

export function buildQboAccount(account: QboAccountSource): Record<string, unknown> {
  const accountType =
    (account.subtype && SUBTYPE_TO_QBO_ACCOUNT_TYPE[account.subtype]) ??
    ACCOUNT_TYPE_TO_QBO[account.type] ??
    'Other Current Asset';
  return { Name: account.name, AccountType: accountType };
}

export interface QboItemSource {
  name: string;
  kind: string;
  defaultPrice: string | null;
}

export function buildQboItem(item: QboItemSource): Record<string, unknown> {
  const body: Record<string, unknown> = {
    Name: item.name,
    Type: item.kind === 'service' ? 'Service' : 'NonInventory',
  };
  if (item.defaultPrice !== null) body.UnitPrice = dollars(toCents(item.defaultPrice));
  return body;
}

export interface QboInvoiceLineSource {
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  /** null when the line has no local item (falls back to a plain amount line with no ItemRef). */
  itemQboId: string | null;
}

export interface QboInvoiceSource {
  docNumber: string | null;
  txnDate: string;
  dueDate: string | null;
  memo: string | null;
}

export function buildQboInvoice(
  txn: QboInvoiceSource,
  lines: QboInvoiceLineSource[],
  customerQboId: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    CustomerRef: { value: customerQboId },
    TxnDate: txn.txnDate,
    Line: lines.map((line) => {
      const detail: Record<string, unknown> = {
        Qty: Number(line.quantity),
        UnitPrice: dollars(toCents(line.unitPrice)),
      };
      if (line.itemQboId) detail.ItemRef = { value: line.itemQboId };
      return {
        Amount: dollars(toCents(line.amount)),
        ...(line.description ? { Description: line.description } : {}),
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: detail,
      };
    }),
  };
  if (txn.docNumber) body.DocNumber = txn.docNumber;
  if (txn.dueDate) body.DueDate = txn.dueDate;
  if (txn.memo) body.PrivateNote = txn.memo;
  return body;
}

export interface QboPaymentLinkedInvoice {
  qboId: string;
  amountCents: number;
}

export function buildQboPayment(params: {
  customerQboId: string;
  txnDate: string;
  totalCents: number;
  linkedInvoices: QboPaymentLinkedInvoice[];
}): Record<string, unknown> {
  return {
    CustomerRef: { value: params.customerQboId },
    TxnDate: params.txnDate,
    TotalAmt: dollars(params.totalCents),
    Line: params.linkedInvoices.map((inv) => ({
      Amount: dollars(inv.amountCents),
      LinkedTxn: [{ TxnId: inv.qboId, TxnType: 'Invoice' }],
    })),
  };
}

// ---------------------------------------------------------------------------
// Push primitives shared by refs (Customer/Account/Item) and documents (Invoice/Payment).
// ---------------------------------------------------------------------------

async function refetchSyncToken(
  deps: OutboundDeps,
  qboType: QboEntityType,
  qboId: string,
): Promise<string | undefined> {
  const envelope = await deps.client.getEntity({
    realmId: deps.realmId,
    accessToken: deps.accessToken,
    entityType: qboType,
    qboId,
  });
  const entity = unwrapEntity(envelope, qboType) as { SyncToken?: string } | undefined;
  return entity?.SyncToken;
}

interface PushResult {
  qboId: string;
  syncToken: string | undefined;
}

/**
 * Outbound redundant-write guard (20008 §0a.4, `.claude/plans/20008-ordering.md`): `true` when
 * this document was already pushed at (or after) its current local `version` — i.e. an UPDATE
 * push would be a no-op sparse update carrying nothing new. Only meaningful for the update path
 * (`existingLink.qboId` present); a link with no `qboId` yet is a CREATE and is never redundant.
 * `localVersion === null` (never recorded) is treated as "not yet confirmed pushed" -> not
 * redundant, so a genuine push still happens.
 */
function isOutboundRedundant(existingLink: SyncLinkRow | null, currentVersion: number): boolean {
  return (
    !!existingLink?.qboId &&
    existingLink.localVersion !== null &&
    existingLink.localVersion !== undefined &&
    existingLink.localVersion >= currentVersion
  );
}

/**
 * Create-vs-update by existing link (decision #3): `existingLink.qboId` present -> sparse
 * UPDATE with the stored SyncToken (refetched from QBO first if the link doesn't have one
 * cached); no link (or a link with no qboId, which shouldn't happen given the schema's NOT NULL
 * constraint but is handled defensively) -> CREATE. Never mutates `sync_links` itself — callers
 * upsert the link with the result.
 */
async function pushEntity(
  deps: OutboundDeps,
  qboType: QboEntityType,
  existingLink: SyncLinkRow | null,
  body: Record<string, unknown>,
): Promise<PushResult> {
  if (existingLink?.qboId) {
    const syncToken =
      existingLink.qboSyncToken ?? (await refetchSyncToken(deps, qboType, existingLink.qboId));
    if (!syncToken) {
      throw new QboApiError(
        `missing SyncToken for ${qboType}:${existingLink.qboId} and refetch returned none`,
        false,
      );
    }
    const envelope = await deps.client.updateEntity({
      realmId: deps.realmId,
      accessToken: deps.accessToken,
      entityType: qboType,
      body: { ...body, Id: existingLink.qboId, SyncToken: syncToken, sparse: true },
    });
    const result = unwrapEntity(envelope, qboType) as { Id?: string; SyncToken?: string };
    if (!result?.Id) throw new QboApiError(`QBO ${qboType} update returned no Id`, false);
    return { qboId: result.Id, syncToken: result.SyncToken };
  }

  const envelope = await deps.client.createEntity({
    realmId: deps.realmId,
    accessToken: deps.accessToken,
    entityType: qboType,
    body,
  });
  const result = unwrapEntity(envelope, qboType) as { Id?: string; SyncToken?: string };
  if (!result?.Id) throw new QboApiError(`QBO ${qboType} create returned no Id`, false);
  return { qboId: result.Id, syncToken: result.SyncToken };
}

async function buildRefBody(
  db: Db,
  orgId: string,
  entityType: Exclude<SyncEntityType, 'transaction'>,
  localId: string,
): Promise<Record<string, unknown>> {
  if (entityType === 'contact') {
    const contact = await getContact(db, orgId, localId);
    if (!contact) throw new Error(`ensureEntitySynced: contact not found: ${localId}`);
    return buildQboCustomer(contact);
  }
  if (entityType === 'account') {
    const [account] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), eq(accounts.id, localId)))
      .limit(1);
    if (!account) throw new Error(`ensureEntitySynced: account not found: ${localId}`);
    return buildQboAccount(account);
  }
  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.orgId, orgId), eq(items.id, localId)))
    .limit(1);
  if (!item) throw new Error(`ensureEntitySynced: item not found: ${localId}`);
  return buildQboItem(item);
}

/**
 * Reference-data-first, `synced`-gated (decision #2): returns the entity's QBO id, pushing it
 * first (create-or-update, per `pushEntity`) unless an existing link is ALREADY `synced` — a
 * `pending`/`failed` link is treated as not satisfying the gate and is (re)pushed. On failure,
 * marks the ref's own link `failed` (a no-op update if no link row exists yet — see
 * `docs/design-decisions.md`), audits, and rethrows so the caller (a document push) aborts too.
 */
export async function ensureEntitySynced(
  db: Db,
  deps: OutboundDeps,
  orgId: string,
  entityType: Exclude<SyncEntityType, 'transaction'>,
  localId: string,
): Promise<string> {
  const existing = await findLinkByLocal(db, orgId, entityType, localId);
  if (existing?.state === 'synced' && existing.qboId) {
    return existing.qboId;
  }

  const qboType = resolveQboType(entityType);
  try {
    const body = await buildRefBody(db, orgId, entityType, localId);
    const { qboId, syncToken } = await pushEntity(deps, qboType, existing, body);

    await upsertLink(db, {
      orgId,
      entityType,
      localId,
      qboType,
      qboId,
      state: 'synced',
      qboSyncToken: syncToken ?? null,
      lastSyncedAt: new Date(),
      // 20011: a successful (re)push always clears any prior failure/retry bookkeeping.
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
    });
    await writeAuditLog(db, {
      orgId,
      userId: null,
      entityType,
      localId,
      action: 'outbound_sync',
      direction: 'outbound',
      outcome: 'success',
      detail: { qboType, qboId },
    });
    return qboId;
  } catch (err) {
    await markFailed(db, orgId, entityType, localId, qboType, errMessage(err));
    await writeAuditLog(db, {
      orgId,
      userId: null,
      entityType,
      localId,
      action: 'outbound_sync',
      direction: 'outbound',
      outcome: 'failure',
      detail: { qboType, error: errMessage(err) },
    });
    throw err;
  }
}

async function failOutbound(
  db: Db,
  params: OutboundParams,
  qboType: QboEntityType,
  txnId: string,
  err: unknown,
  action: 'outbound_sync' | 'outbound_void' | 'outbound_delete' = 'outbound_sync',
): Promise<OutboundResult> {
  // 20010: a `force` push only ever happens from the conflict-resolution route's `winner:'local'`
  // path (§0a.4/§3) — on failure the link must stay `conflict` (not left half-resolved as
  // `failed`, which would drop it out of `GET /api/conflicts` and into the 20011 retry loop
  // instead of back in front of the user who's actively resolving it).
  if (params.force) {
    await markConflict(db, params.orgId, 'transaction', txnId);
  } else {
    await markFailed(db, params.orgId, 'transaction', txnId, qboType, errMessage(err));
  }
  await writeAuditLog(db, {
    orgId: params.orgId,
    userId: params.userId ?? null,
    entityType: 'transaction',
    localId: txnId,
    action,
    direction: 'outbound',
    outcome: 'failure',
    detail: { qboType, error: errMessage(err) },
  });
  return { status: 'failed', reason: errMessage(err) };
}

/**
 * Void, not delete (decision #4): if the document was never pushed (no link / no qboId), voiding
 * it locally has nothing to undo in QBO — skip, no error, no spurious link. Otherwise issue a
 * QBO void against the linked record; the link stays `synced` (the record still exists in QBO,
 * just zeroed) on success, or `failed` on failure.
 */
async function voidDocument(
  db: Db,
  deps: OutboundDeps,
  params: OutboundParams,
  qboType: QboEntityType,
  txn: { id: string; version: number },
): Promise<OutboundResult> {
  const link = await findLinkByLocal(db, params.orgId, 'transaction', txn.id);
  if (!link?.qboId) {
    return { status: 'skipped' };
  }

  try {
    const syncToken = link.qboSyncToken ?? (await refetchSyncToken(deps, qboType, link.qboId));
    if (!syncToken) {
      throw new QboApiError(`missing SyncToken for ${qboType}:${link.qboId} void`, false);
    }

    const envelope = await deps.client.voidEntity({
      realmId: deps.realmId,
      accessToken: deps.accessToken,
      entityType: qboType,
      qboId: link.qboId,
      syncToken,
    });
    const voided = unwrapEntity(envelope, qboType) as { SyncToken?: string } | undefined;

    await markSynced(db, params.orgId, 'transaction', txn.id, {
      qboSyncToken: voided?.SyncToken ?? syncToken,
      localVersion: txn.version,
      lastSyncedAt: new Date(),
    });
    await writeAuditLog(db, {
      orgId: params.orgId,
      userId: params.userId ?? null,
      entityType: 'transaction',
      localId: txn.id,
      action: 'outbound_void',
      direction: 'outbound',
      outcome: 'success',
      detail: { qboType, qboId: link.qboId },
    });
    return { status: 'synced', qboId: link.qboId };
  } catch (err) {
    return failOutbound(db, params, qboType, txn.id, err, 'outbound_void');
  }
}

/**
 * Delete, not void (decision #6, 20009): mirrors `voidDocument` exactly except it calls
 * `deleteEntity` (`?operation=delete`) and audits `outbound_delete` instead of `outbound_void`.
 * If the document was never pushed (no link / no qboId), deleting it locally has nothing to
 * undo in QBO — skip, no error, no spurious link. Otherwise issue a QBO delete against the
 * linked record; the link stays `synced` afterward (retained deliberately — see
 * `docs/design-decisions.md` ## Delete vs void — so a later create/update event for the same
 * qboId is recognized as already-linked and never resurrects a live local record).
 */
async function deleteDocument(
  db: Db,
  deps: OutboundDeps,
  params: OutboundParams,
  qboType: QboEntityType,
  txn: { id: string; version: number },
): Promise<OutboundResult> {
  const link = await findLinkByLocal(db, params.orgId, 'transaction', txn.id);
  if (!link?.qboId) {
    return { status: 'skipped' };
  }

  try {
    const syncToken = link.qboSyncToken ?? (await refetchSyncToken(deps, qboType, link.qboId));
    if (!syncToken) {
      throw new QboApiError(`missing SyncToken for ${qboType}:${link.qboId} delete`, false);
    }

    const envelope = await deps.client.deleteEntity({
      realmId: deps.realmId,
      accessToken: deps.accessToken,
      entityType: qboType,
      qboId: link.qboId,
      syncToken,
    });
    const deleted = unwrapEntity(envelope, qboType) as { SyncToken?: string } | undefined;

    await markSynced(db, params.orgId, 'transaction', txn.id, {
      qboSyncToken: deleted?.SyncToken ?? syncToken,
      localVersion: txn.version,
      lastSyncedAt: new Date(),
    });
    await writeAuditLog(db, {
      orgId: params.orgId,
      userId: params.userId ?? null,
      entityType: 'transaction',
      localId: txn.id,
      action: 'outbound_delete',
      direction: 'outbound',
      outcome: 'success',
      detail: { qboType, qboId: link.qboId },
    });
    return { status: 'synced', qboId: link.qboId };
  } catch (err) {
    return failOutbound(db, params, qboType, txn.id, err, 'outbound_delete');
  }
}

// ---------------------------------------------------------------------------
// Document-level entry points.
// ---------------------------------------------------------------------------

/**
 * Pushes a `customer_invoice` transaction outbound: void -> `voidDocument`; otherwise ensures
 * the contact and every distinct line account/item are `synced` first (decision #2), then
 * create-or-updates the QBO Invoice (decision #3) and marks the link `synced` with the local
 * `version` snapshot (so later ordering/conflict tasks can compare against it). Any failure
 * along the way marks the invoice's own link `failed` + audits `outbound_sync`/`failure` and
 * returns `{status: 'failed'}` — it never throws for an expected QBO/mapping failure, and never
 * rolls back the local invoice (the caller already committed it).
 */
export async function syncInvoiceOutbound(
  db: Db,
  deps: OutboundDeps,
  params: OutboundParams,
): Promise<OutboundResult> {
  const [txn] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.orgId, params.orgId),
        eq(transactions.id, params.txnId),
        eq(transactions.type, 'customer_invoice'),
      ),
    )
    .limit(1);
  if (!txn) throw new Error(`syncInvoiceOutbound: invoice not found: ${params.txnId}`);

  // 20010: stop writing in BOTH directions while `conflict` (decision #3) — a conflicted link's
  // local edits are never propagated until a human resolves it via `POST /api/conflicts/:id/resolve`.
  // Bypassed only by that route's own `winner:'local'` force-push (`params.force`).
  if (!params.force) {
    const guardLink = await findLinkByLocal(db, params.orgId, 'transaction', txn.id);
    if (guardLink?.state === 'conflict') {
      await writeAuditLog(db, {
        orgId: params.orgId,
        userId: params.userId ?? null,
        entityType: 'transaction',
        localId: txn.id,
        action: 'outbound_sync',
        direction: 'outbound',
        outcome: 'skipped',
        detail: { qboType: 'Invoice', reason: 'conflict_blocked' },
      });
      return { status: 'skipped', reason: 'conflict_blocked' };
    }
  }

  // Decision #6: check `deletedAt` BEFORE `status` — a voided-then-deleted invoice must push a
  // QBO delete, not a void (deletedAt is the more terminal of the two local states).
  if (txn.deletedAt) {
    return deleteDocument(db, deps, params, 'Invoice', txn);
  }
  if (txn.status === 'void') {
    return voidDocument(db, deps, params, 'Invoice', txn);
  }

  try {
    if (!txn.contactId) throw new QboApiError('invoice has no contact to sync', false);

    const customerQboId = await ensureEntitySynced(
      db,
      deps,
      params.orgId,
      'contact',
      txn.contactId,
    );

    const lines = await db
      .select()
      .from(transactionLines)
      .where(
        and(eq(transactionLines.orgId, params.orgId), eq(transactionLines.transactionId, txn.id)),
      )
      .orderBy(asc(transactionLines.lineNumber));

    const accountQboIds = new Map<string, string>();
    const itemQboIds = new Map<string, string>();
    for (const line of lines) {
      if (!accountQboIds.has(line.accountId)) {
        accountQboIds.set(
          line.accountId,
          await ensureEntitySynced(db, deps, params.orgId, 'account', line.accountId),
        );
      }
      if (line.itemId && !itemQboIds.has(line.itemId)) {
        itemQboIds.set(
          line.itemId,
          await ensureEntitySynced(db, deps, params.orgId, 'item', line.itemId),
        );
      }
    }

    const invoiceLines: QboInvoiceLineSource[] = lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
      itemQboId: line.itemId ? (itemQboIds.get(line.itemId) ?? null) : null,
    }));
    const body = buildQboInvoice(txn, invoiceLines, customerQboId);

    const existingLink = await findLinkByLocal(db, params.orgId, 'transaction', txn.id);
    if (!params.force && isOutboundRedundant(existingLink, txn.version)) {
      await writeAuditLog(db, {
        orgId: params.orgId,
        userId: params.userId ?? null,
        entityType: 'transaction',
        localId: txn.id,
        action: 'outbound_sync',
        direction: 'outbound',
        outcome: 'skipped',
        detail: {
          qboType: 'Invoice',
          qboId: existingLink?.qboId,
          reason: 'already_current',
          localVersion: existingLink?.localVersion,
          txnVersion: txn.version,
        },
      });
      return {
        status: 'skipped',
        qboId: existingLink?.qboId ?? undefined,
        reason: 'already_current',
      };
    }
    const { qboId, syncToken } = await pushEntity(deps, 'Invoice', existingLink, body);

    await upsertLink(db, {
      orgId: params.orgId,
      entityType: 'transaction',
      localId: txn.id,
      qboType: 'Invoice',
      qboId,
      state: 'synced',
      localVersion: txn.version,
      qboSyncToken: syncToken ?? null,
      lastSyncedAt: new Date(),
      // 20010: reaching a successful push always clears any prior conflict — either there was
      // none (no-op), or this IS the `winner:'local'` resolution's force-push re-driving sync.
      conflictDetectedAt: null,
      // 20011: a successful (re)push always clears any prior failure/retry bookkeeping too.
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
    });
    await writeAuditLog(db, {
      orgId: params.orgId,
      userId: params.userId ?? null,
      entityType: 'transaction',
      localId: txn.id,
      action: 'outbound_sync',
      direction: 'outbound',
      outcome: 'success',
      detail: {
        qboType: 'Invoice',
        qboId,
        idempotencyKey: outboundIdempotencyKey({
          orgId: params.orgId,
          entityType: 'transaction',
          localId: txn.id,
          localVersion: txn.version,
        }),
      },
    });

    return { status: 'synced', qboId };
  } catch (err) {
    return failOutbound(db, params, 'Invoice', txn.id, err);
  }
}

/** Ensures the applied invoice is `synced` before a payment referencing it is pushed, reusing
 * `syncInvoiceOutbound` itself (which is idempotent) rather than duplicating its ref-gating +
 * create-vs-update logic. Throws if the invoice still isn't synced afterward (e.g. its own push
 * just failed) — the payment push can't attach a `LinkedTxn` to an unsynced invoice. */
async function ensureInvoiceSynced(
  db: Db,
  deps: OutboundDeps,
  params: OutboundParams,
  invoiceTxnId: string,
): Promise<string> {
  const link = await findLinkByLocal(db, params.orgId, 'transaction', invoiceTxnId);
  if (link?.state === 'synced' && link.qboId) return link.qboId;

  const result = await syncInvoiceOutbound(db, deps, {
    orgId: params.orgId,
    txnId: invoiceTxnId,
    userId: params.userId,
  });
  if (result.status !== 'synced' || !result.qboId) {
    throw new QboApiError(
      `applied invoice ${invoiceTxnId} could not be synced to QBO first`,
      false,
    );
  }
  return result.qboId;
}

/**
 * Pushes a `payment` transaction outbound: void -> `voidDocument`; otherwise ensures the
 * contact and every invoice the payment applies to (via `payment_applications`) are `synced`
 * first, then create-or-updates the QBO Payment with a `LinkedTxn` per applied invoice. Same
 * failure/idempotency shape as `syncInvoiceOutbound`.
 */
export async function syncPaymentOutbound(
  db: Db,
  deps: OutboundDeps,
  params: OutboundParams,
): Promise<OutboundResult> {
  const [txn] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.orgId, params.orgId),
        eq(transactions.id, params.txnId),
        eq(transactions.type, 'payment'),
      ),
    )
    .limit(1);
  if (!txn) throw new Error(`syncPaymentOutbound: payment not found: ${params.txnId}`);

  // 20010: same conflict-blocked guard as `syncInvoiceOutbound` above.
  if (!params.force) {
    const guardLink = await findLinkByLocal(db, params.orgId, 'transaction', txn.id);
    if (guardLink?.state === 'conflict') {
      await writeAuditLog(db, {
        orgId: params.orgId,
        userId: params.userId ?? null,
        entityType: 'transaction',
        localId: txn.id,
        action: 'outbound_sync',
        direction: 'outbound',
        outcome: 'skipped',
        detail: { qboType: 'Payment', reason: 'conflict_blocked' },
      });
      return { status: 'skipped', reason: 'conflict_blocked' };
    }
  }

  // Decision #6: check `deletedAt` BEFORE `status` — see the matching comment in
  // `syncInvoiceOutbound` above.
  if (txn.deletedAt) {
    return deleteDocument(db, deps, params, 'Payment', txn);
  }
  if (txn.status === 'void') {
    return voidDocument(db, deps, params, 'Payment', txn);
  }

  try {
    if (!txn.contactId) throw new QboApiError('payment has no contact to sync', false);
    const customerQboId = await ensureEntitySynced(
      db,
      deps,
      params.orgId,
      'contact',
      txn.contactId,
    );

    const applications = await db
      .select()
      .from(paymentApplications)
      .where(
        and(
          eq(paymentApplications.orgId, params.orgId),
          eq(paymentApplications.paymentTxnId, txn.id),
        ),
      );
    if (applications.length === 0) {
      throw new QboApiError('payment has no invoice application to sync', false);
    }

    const linkedInvoices: QboPaymentLinkedInvoice[] = [];
    for (const application of applications) {
      const invoiceQboId = await ensureInvoiceSynced(db, deps, params, application.invoiceTxnId);
      linkedInvoices.push({ qboId: invoiceQboId, amountCents: toCents(application.amount) });
    }

    const body = buildQboPayment({
      customerQboId,
      txnDate: txn.txnDate,
      totalCents: toCents(txn.total),
      linkedInvoices,
    });

    const existingLink = await findLinkByLocal(db, params.orgId, 'transaction', txn.id);
    if (!params.force && isOutboundRedundant(existingLink, txn.version)) {
      await writeAuditLog(db, {
        orgId: params.orgId,
        userId: params.userId ?? null,
        entityType: 'transaction',
        localId: txn.id,
        action: 'outbound_sync',
        direction: 'outbound',
        outcome: 'skipped',
        detail: {
          qboType: 'Payment',
          qboId: existingLink?.qboId,
          reason: 'already_current',
          localVersion: existingLink?.localVersion,
          txnVersion: txn.version,
        },
      });
      return {
        status: 'skipped',
        qboId: existingLink?.qboId ?? undefined,
        reason: 'already_current',
      };
    }
    const { qboId, syncToken } = await pushEntity(deps, 'Payment', existingLink, body);

    await upsertLink(db, {
      orgId: params.orgId,
      entityType: 'transaction',
      localId: txn.id,
      qboType: 'Payment',
      qboId,
      state: 'synced',
      localVersion: txn.version,
      qboSyncToken: syncToken ?? null,
      lastSyncedAt: new Date(),
      conflictDetectedAt: null,
    });
    await writeAuditLog(db, {
      orgId: params.orgId,
      userId: params.userId ?? null,
      entityType: 'transaction',
      localId: txn.id,
      action: 'outbound_sync',
      direction: 'outbound',
      outcome: 'success',
      detail: {
        qboType: 'Payment',
        qboId,
        idempotencyKey: outboundIdempotencyKey({
          orgId: params.orgId,
          entityType: 'transaction',
          localId: txn.id,
          localVersion: txn.version,
        }),
      },
    });

    return { status: 'synced', qboId };
  } catch (err) {
    return failOutbound(db, params, 'Payment', txn.id, err);
  }
}

// ---------------------------------------------------------------------------
// Route-facing best-effort wrappers. Routes call these after the domain mutation's own
// transaction has already committed; both resolve deps + push, and swallow every failure
// (expected QBO/mapping errors are already turned into a `failed` link + audit row by the sync
// functions above — this outer catch is only a backstop for anything unexpected) so an outbound
// problem can never affect the HTTP response.
// ---------------------------------------------------------------------------

export async function pushInvoiceOutbound(
  db: Db,
  oauthClient: QboOAuthClient | null,
  apiClient: QboWriteClient | null,
  params: OutboundParams,
): Promise<void> {
  try {
    const deps = await resolveOutboundDeps({ db, oauthClient, apiClient, orgId: params.orgId });
    if (!deps) return;
    await syncInvoiceOutbound(db, deps, params);
  } catch {
    // best-effort: never let an outbound failure affect the caller's request.
  }
}

export async function pushPaymentOutbound(
  db: Db,
  oauthClient: QboOAuthClient | null,
  apiClient: QboWriteClient | null,
  params: OutboundParams,
): Promise<void> {
  try {
    const deps = await resolveOutboundDeps({ db, oauthClient, apiClient, orgId: params.orgId });
    if (!deps) return;
    await syncPaymentOutbound(db, deps, params);
  } catch {
    // best-effort: never let an outbound failure affect the caller's request.
  }
}
