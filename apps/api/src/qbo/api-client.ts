import { QboApiError, QboAuthError, QboNotFoundError } from './errors.ts';

export type QboEntityType = 'Invoice' | 'Payment' | 'Customer' | 'Account' | 'Item';

/** QBO wraps the record under a key named after the entity type, e.g. `{ Invoice: {...},
 * time: '...' }`. Callers pick the entity out via `unwrapEntity` (or index directly). */
export type QboEntityEnvelope = Record<string, unknown>;

export interface QboApiClient {
  getEntity(params: {
    realmId: string;
    accessToken: string;
    entityType: QboEntityType;
    qboId: string;
  }): Promise<QboEntityEnvelope>;
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

export function createQboApiClient(opts: CreateQboApiClientOptions): QboApiClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = BASE_URL_BY_ENVIRONMENT[opts.environment];

  return {
    async getEntity({ realmId, accessToken, entityType, qboId }) {
      const url = `${baseUrl}/v3/company/${encodeURIComponent(realmId)}/${entityType}/${encodeURIComponent(qboId)}?minorversion=${MINOR_VERSION}`;

      const res = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const message = `QBO ${entityType} fetch failed: ${res.status} ${detail}`;
        if (res.status === 401) throw new QboAuthError(message);
        if (res.status === 404) throw new QboNotFoundError(message);
        if (res.status === 429 || res.status >= 500) throw new QboApiError(message, true);
        throw new QboApiError(message, false);
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new QboApiError(`QBO ${entityType} fetch failed: malformed JSON response`, false);
      }
      if (body === null || typeof body !== 'object') {
        throw new QboApiError(`QBO ${entityType} fetch failed: empty/invalid response body`, false);
      }

      return body as QboEntityEnvelope;
    },
  };
}
