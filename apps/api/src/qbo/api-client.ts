import { QboApiError, QboAuthError, QboNotFoundError } from './errors.ts';

export type QboEntityType = 'Invoice' | 'Payment' | 'Customer' | 'Account' | 'Item';

/** QBO wraps the record under a key named after the entity type, e.g. `{ Invoice: {...},
 * time: '...' }`. Callers pick the entity out via `unwrapEntity` (or index directly). */
export type QboEntityEnvelope = Record<string, unknown>;

export interface GetEntityParams {
  realmId: string;
  accessToken: string;
  entityType: QboEntityType;
  qboId: string;
}

export interface WriteEntityParams {
  realmId: string;
  accessToken: string;
  entityType: QboEntityType;
  /** The full (create) or sparse (update, `body.sparse = true` + `Id`/`SyncToken` present) QBO
   * entity payload. Built by the pure payload builders in `qbo/outbound-sync.ts`. */
  body: Record<string, unknown>;
}

export interface VoidEntityParams {
  realmId: string;
  accessToken: string;
  entityType: QboEntityType;
  qboId: string;
  /** QBO requires the current SyncToken on every write, including void. */
  syncToken: string;
}

export interface QboApiClient {
  getEntity(params: GetEntityParams): Promise<QboEntityEnvelope>;
  /** POST `/v3/company/{realmId}/{entity}` — creates a new QBO record. Callers (outbound-sync)
   * only call this when no `SyncLink` with a `qboId` exists yet for the local record, so a
   * retried create becomes an `updateEntity` call instead of a duplicate. */
  createEntity(params: WriteEntityParams): Promise<QboEntityEnvelope>;
  /** POST `/v3/company/{realmId}/{entity}` with `Id` + `SyncToken` (+ `sparse: true`) in the
   * body — a sparse update against an existing QBO record. */
  updateEntity(params: WriteEntityParams): Promise<QboEntityEnvelope>;
  /** POST `/v3/company/{realmId}/{entity}?operation=void` — voids (does not delete) an existing
   * QBO record; keeps the record, zeroes its amounts. */
  voidEntity(params: VoidEntityParams): Promise<QboEntityEnvelope>;
}

export interface CreateQboApiClientOptions {
  environment: 'sandbox' | 'production';
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

// Pinned so the response shape doesn't shift under us on Intuit's rolling minor-version
// releases; bump deliberately when adopting a new minor version's fields.
const MINOR_VERSION = '73';

const BASE_URL_BY_ENVIRONMENT: Record<'sandbox' | 'production', string> = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
};

/** Pulls the record out of QBO's `{ <EntityType>: {...}, time: '...' }` envelope. */
export function unwrapEntity(envelope: QboEntityEnvelope, entityType: QboEntityType): unknown {
  return envelope[entityType];
}

/** Shared non-2xx / malformed-body -> typed-error mapping, used by every request this client
 * makes (read and write alike) so the classification stays in exactly one place. */
async function parseResponse(res: Response, entityType: QboEntityType): Promise<QboEntityEnvelope> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const message = `QBO ${entityType} request failed: ${res.status} ${detail}`;
    if (res.status === 401) throw new QboAuthError(message);
    if (res.status === 404) throw new QboNotFoundError(message);
    if (res.status === 429 || res.status >= 500) throw new QboApiError(message, true);
    throw new QboApiError(message, false);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new QboApiError(`QBO ${entityType} request failed: malformed JSON response`, false);
  }
  if (body === null || typeof body !== 'object') {
    throw new QboApiError(`QBO ${entityType} request failed: empty/invalid response body`, false);
  }

  return body as QboEntityEnvelope;
}

function entityUrl(baseUrl: string, realmId: string, entityType: QboEntityType): string {
  return `${baseUrl}/v3/company/${encodeURIComponent(realmId)}/${entityType}`;
}

export function createQboApiClient(opts: CreateQboApiClientOptions): QboApiClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = BASE_URL_BY_ENVIRONMENT[opts.environment];

  async function post(
    entityType: QboEntityType,
    realmId: string,
    accessToken: string,
    body: Record<string, unknown>,
    query: Record<string, string> = {},
  ): Promise<QboEntityEnvelope> {
    const url = new URL(entityUrl(baseUrl, realmId, entityType));
    url.searchParams.set('minorversion', MINOR_VERSION);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const res = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return parseResponse(res, entityType);
  }

  return {
    async getEntity({ realmId, accessToken, entityType, qboId }) {
      const url = `${entityUrl(baseUrl, realmId, entityType)}/${encodeURIComponent(qboId)}?minorversion=${MINOR_VERSION}`;
      const res = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      return parseResponse(res, entityType);
    },

    createEntity({ realmId, accessToken, entityType, body }) {
      return post(entityType, realmId, accessToken, body);
    },

    updateEntity({ realmId, accessToken, entityType, body }) {
      return post(entityType, realmId, accessToken, body);
    },

    voidEntity({ realmId, accessToken, entityType, qboId, syncToken }) {
      return post(
        entityType,
        realmId,
        accessToken,
        { Id: qboId, SyncToken: syncToken },
        { operation: 'void' },
      );
    },
  };
}
