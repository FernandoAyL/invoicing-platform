import { createErrorClass } from '../lib/typed-error.ts';

/** Thrown when a route needs the QBO integration but `config.qbo` / the injected client is null. */
export const QboNotConfiguredError = createErrorClass(
  'QboNotConfiguredError',
  'QuickBooks Online integration is not configured',
);

/** Thrown by `getValidAccessToken` when there is no connection row, or the refresh token itself
 * is no longer valid — callers should surface "reconnect required" rather than retry. */
export const QboNotConnectedError = createErrorClass(
  'QboNotConnectedError',
  'No active QuickBooks Online connection',
);

/** Thrown by the Intuit OAuth HTTP client on a non-OK response from the token/revoke endpoints. */
export const QboOAuthError = createErrorClass('QboOAuthError');

/** Thrown by the QBO data-API client on a 401 from an entity read — the access token was
 * rejected despite `getValidAccessToken` believing it was fresh (e.g. revoked mid-flight on
 * Intuit's side). Distinct from `QboNotConnectedError`: callers should surface "reconnect". */
export const QboAuthError = createErrorClass(
  'QboAuthError',
  'QuickBooks Online rejected the access token',
);

/** Thrown by the QBO data-API client on a 404 from an entity read — the entity was deleted or
 * never existed in QBO. Callers (20007/20009) interpret this as delete semantics. */
export const QboNotFoundError = createErrorClass(
  'QboNotFoundError',
  'QuickBooks Online entity not found',
);

/** Thrown by the QBO data-API client on any other non-2xx response, or a malformed 200 body.
 * `retryable` is true for 429/5xx (transient — 20011's retry/backoff logic can act on it) and
 * false for other non-2xx statuses and malformed bodies. Plain field, not a parameter property. */
export class QboApiError extends Error {
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'QboApiError';
    this.retryable = retryable;
  }
}

/** Thrown by `resolveQboType` (sync-link-service) when a `sync_entity_type` has no defined QBO
 * document mapping for the given input — currently any `transaction` whose `Transaction.type` is
 * not `customer_invoice`/`payment` (e.g. `journal_entry`, `expense` — Phase 4 territory), or a
 * `transaction` entityType called without a `txnType`. Callers (`resolveTransactionDeps`, the
 * outbound sync executor) should skip/report rather than push. */
export const UnmappableEntityError = createErrorClass('UnmappableEntityError');

/** Thrown by `upsertLink` when the local<->QBO pair being linked conflicts with an existing
 * `sync_links` row — either this local record is already linked to a different QBO id/type, or
 * this QBO id is already linked to a different local record. Per the mapping design, a
 * conflicting link is never silently overwritten; the caller must resolve it (surfaced to a
 * human, same as an ambiguous natural-key match). */
export const ConflictingLinkError = createErrorClass('ConflictingLinkError');
