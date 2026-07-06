import { describe, expect, it, vi } from 'vitest';
import { QboOAuthError } from './errors.ts';
import { createIntuitOAuthClient } from './oauth-client.ts';

const BASE_OPTS = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'http://localhost:8080/api/integrations/qbo/callback',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createIntuitOAuthClient / authorizeUrl', () => {
  it('builds the Intuit authorize URL with client_id, scope, redirect_uri, and state', () => {
    const client = createIntuitOAuthClient(BASE_OPTS);
    const url = new URL(client.authorizeUrl({ state: 'signed-state-token' }));

    expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(url.searchParams.get('redirect_uri')).toBe(BASE_OPTS.redirectUri);
    expect(url.searchParams.get('state')).toBe('signed-state-token');
  });
});

describe('createIntuitOAuthClient / exchangeCode', () => {
  it('POSTs to the token endpoint with Basic auth, urlencoded body, and grant_type=authorization_code', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        x_refresh_token_expires_in: 8726400,
      }),
    );

    const client = createIntuitOAuthClient({ ...BASE_OPTS, fetchImpl });
    const result = await client.exchangeCode('auth-code-xyz');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('client-123:secret-456').toString('base64')}`,
    );
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-xyz');
    expect(body.get('redirect_uri')).toBe(BASE_OPTS.redirectUri);

    expect(result).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 8726400,
    });
  });

  it('throws QboOAuthError on a non-OK response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('invalid_grant', { status: 400, statusText: 'Bad Request' }),
    );
    const client = createIntuitOAuthClient({ ...BASE_OPTS, fetchImpl });

    await expect(client.exchangeCode('bad-code')).rejects.toThrow(QboOAuthError);
  });
});

describe('createIntuitOAuthClient / refresh', () => {
  it('POSTs grant_type=refresh_token with the refresh token, no redirect_uri', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_in: 3600,
        x_refresh_token_expires_in: 8726400,
      }),
    );
    const client = createIntuitOAuthClient({ ...BASE_OPTS, fetchImpl });

    const result = await client.refresh('old-refresh-token');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh-token');
    expect(body.has('redirect_uri')).toBe(false);
    expect(result.accessToken).toBe('access-2');
  });

  it('throws QboOAuthError when Intuit rejects the refresh token', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('invalid_grant', { status: 400, statusText: 'Bad Request' }),
    );
    const client = createIntuitOAuthClient({ ...BASE_OPTS, fetchImpl });

    await expect(client.refresh('revoked-token')).rejects.toThrow(QboOAuthError);
  });
});

describe('createIntuitOAuthClient / revoke', () => {
  it('POSTs the refresh token as JSON with Basic auth', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const client = createIntuitOAuthClient({ ...BASE_OPTS, fetchImpl });

    await client.revoke('some-refresh-token');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://developer.api.intuit.com/v2/oauth2/tokens/revoke');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('client-123:secret-456').toString('base64')}`,
    );
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'some-refresh-token' });
  });

  it('throws QboOAuthError on a non-OK response', async () => {
    const fetchImpl = vi.fn(async () => new Response('error', { status: 500 }));
    const client = createIntuitOAuthClient({ ...BASE_OPTS, fetchImpl });

    await expect(client.revoke('some-refresh-token')).rejects.toThrow(QboOAuthError);
  });
});
