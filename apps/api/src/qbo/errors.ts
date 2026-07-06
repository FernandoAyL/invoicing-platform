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
