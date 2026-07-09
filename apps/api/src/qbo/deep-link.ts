// Builds a browser deep-link to a record inside the QuickBooks Online web app, so the UI can offer
// a "View in QuickBooks" link next to a synced invoice/customer. QBO deep links are session-scoped
// (they resolve against whichever company the signed-in user has active), so the URL only needs the
// record type + id — not the realm. The host differs by environment; sandbox companies live on a
// separate host from production.

import type { QboEntityType } from './api-client.ts';

const HOST_BY_ENVIRONMENT: Record<'sandbox' | 'production', string> = {
  sandbox: 'https://app.sandbox.qbo.intuit.com',
  production: 'https://app.qbo.intuit.com',
};

// Per-entity path + query-param name QBO's web app uses to open a single record.
const PATH_BY_ENTITY: Partial<Record<QboEntityType, { path: string; param: string }>> = {
  Invoice: { path: 'invoice', param: 'txnId' },
  Customer: { path: 'customerdetail', param: 'nameId' },
  Payment: { path: 'recvpayment', param: 'txnId' },
};

/**
 * Deep link to a single QBO record, or `null` when the entity type has no known detail page or
 * `qboId` is missing (never synced) — callers render the link only when this returns a string.
 */
export function qboEntityUrl(
  environment: 'sandbox' | 'production',
  entityType: QboEntityType,
  qboId: string | null | undefined,
): string | null {
  if (!qboId) return null;
  const entity = PATH_BY_ENTITY[entityType];
  if (!entity) return null;
  return `${HOST_BY_ENVIRONMENT[environment]}/app/${entity.path}?${entity.param}=${encodeURIComponent(qboId)}`;
}
