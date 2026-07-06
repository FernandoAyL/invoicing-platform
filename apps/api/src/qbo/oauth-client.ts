import { QboOAuthError } from './errors.ts';

export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

export interface QboTokenResult {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires (Intuit's `expires_in`). */
  accessTokenExpiresIn: number;
  /** Seconds until the refresh token expires (Intuit's `x_refresh_token_expires_in`). */
  refreshTokenExpiresIn: number;
  /** Intuit's token endpoint does not return this; present only if a caller sets it. */
  realmId?: string;
}

/**
 * The Intuit OAuth2 dance, abstracted so tests can inject a stub instead of driving a real
 * browser redirect through Intuit's login. `authorizeUrl` builds the link the frontend redirects
 * the browser to; `exchangeCode`/`refresh`/`revoke` are the server-to-server token calls.
 */
export interface QboOAuthClient {
  authorizeUrl(params: { state: string }): string;
  exchangeCode(code: string): Promise<QboTokenResult>;
  refresh(refreshToken: string): Promise<QboTokenResult>;
  revoke(refreshToken: string): Promise<void>;
}

export interface IntuitOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

interface TokenResponseBody {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

async function requestToken(
  fetchImpl: typeof fetch,
  opts: IntuitOAuthClientOptions,
  params: Record<string, string>,
): Promise<QboTokenResult> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(opts.clientId, opts.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new QboOAuthError(`QBO token request failed: ${res.status} ${detail}`);
  }
  const body = (await res.json()) as TokenResponseBody;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessTokenExpiresIn: body.expires_in,
    refreshTokenExpiresIn: body.x_refresh_token_expires_in,
  };
}

export function createIntuitOAuthClient(opts: IntuitOAuthClientOptions): QboOAuthClient {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    authorizeUrl({ state }) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('client_id', opts.clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', QBO_SCOPE);
      url.searchParams.set('redirect_uri', opts.redirectUri);
      url.searchParams.set('state', state);
      return url.toString();
    },

    exchangeCode(code) {
      return requestToken(fetchImpl, opts, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: opts.redirectUri,
      });
    },

    refresh(refreshToken) {
      return requestToken(fetchImpl, opts, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    },

    async revoke(refreshToken) {
      const res = await fetchImpl(REVOKE_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuthHeader(opts.clientId, opts.clientSecret),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ token: refreshToken }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new QboOAuthError(`QBO revoke request failed: ${res.status} ${detail}`);
      }
    },
  };
}
