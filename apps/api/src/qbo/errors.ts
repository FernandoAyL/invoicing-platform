/** Thrown when a route needs the QBO integration but `config.qbo` / the injected client is null. */
export class QboNotConfiguredError extends Error {
  constructor(message = 'QuickBooks Online integration is not configured') {
    super(message);
    this.name = 'QboNotConfiguredError';
  }
}

/** Thrown by `getValidAccessToken` when there is no connection row, or the refresh token itself
 * is no longer valid — callers should surface "reconnect required" rather than retry. */
export class QboNotConnectedError extends Error {
  constructor(message = 'No active QuickBooks Online connection') {
    super(message);
    this.name = 'QboNotConnectedError';
  }
}

/** Thrown by the Intuit OAuth HTTP client on a non-OK response from the token/revoke endpoints. */
export class QboOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QboOAuthError';
  }
}

/** Thrown by the QBO data-API client on a 401 from an entity read — the access token was
 * rejected despite `getValidAccessToken` believing it was fresh (e.g. revoked mid-flight on
 * Intuit's side). Distinct from `QboNotConnectedError`: callers should surface "reconnect". */
export class QboAuthError extends Error {
  constructor(message = 'QuickBooks Online rejected the access token') {
    super(message);
    this.name = 'QboAuthError';
  }
}

/** Thrown by the QBO data-API client on a 404 from an entity read — the entity was deleted or
 * never existed in QBO. Callers (20007/20009) interpret this as delete semantics. */
export class QboNotFoundError extends Error {
  constructor(message = 'QuickBooks Online entity not found') {
    super(message);
    this.name = 'QboNotFoundError';
  }
}

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
