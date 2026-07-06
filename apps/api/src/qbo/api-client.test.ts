import { describe, expect, it, vi } from 'vitest';
import { createQboApiClient, unwrapEntity } from './api-client.ts';
import { QboAuthError, QboNotFoundError } from './errors.ts';

const ACCESS_TOKEN = 'super-secret-access-token';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createQboApiClient / getEntity', () => {
  it('requests sandbox base URL, correct path/query, and required headers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { Invoice: { Id: '145' }, time: 't' }));
    const client = createQboApiClient({ environment: 'sandbox', fetchImpl });

    await client.getEntity({
      realmId: 'realm-1',
      accessToken: ACCESS_TOKEN,
      entityType: 'Invoice',
      qboId: '145',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://sandbox-quickbooks.api.intuit.com');
    expect(parsed.pathname).toBe('/v3/company/realm-1/Invoice/145');
    expect(parsed.searchParams.get('minorversion')).toBeTruthy();

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.Accept).toBe('application/json');
  });

  it('requests the production base URL when environment is production', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { Payment: {} }));
    const client = createQboApiClient({ environment: 'production', fetchImpl });

    await client.getEntity({
      realmId: 'realm-2',
      accessToken: ACCESS_TOKEN,
      entityType: 'Payment',
      qboId: '9',
    });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(new URL(url).origin).toBe('https://quickbooks.api.intuit.com');
  });

  it('parses the entity envelope on success', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { Invoice: { Id: '145', TotalAmt: 100 }, time: '2026-07-06T00:00:00Z' }),
    );
    const client = createQboApiClient({ environment: 'sandbox', fetchImpl });

    const envelope = await client.getEntity({
      realmId: 'realm-1',
      accessToken: ACCESS_TOKEN,
      entityType: 'Invoice',
      qboId: '145',
    });

    expect(unwrapEntity(envelope, 'Invoice')).toEqual({ Id: '145', TotalAmt: 100 });
  });

  it('maps 401 to QboAuthError without leaking the bearer token', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const client = createQboApiClient({ environment: 'sandbox', fetchImpl });

    await expect(
      client.getEntity({
        realmId: 'realm-1',
        accessToken: ACCESS_TOKEN,
        entityType: 'Invoice',
        qboId: '145',
      }),
    ).rejects.toThrow(QboAuthError);

    try {
      await client.getEntity({
        realmId: 'realm-1',
        accessToken: ACCESS_TOKEN,
        entityType: 'Invoice',
        qboId: '145',
      });
    } catch (err) {
      expect(err instanceof Error && err.message.includes(ACCESS_TOKEN)).toBe(false);
    }
  });

  it('maps 404 to QboNotFoundError', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    const client = createQboApiClient({ environment: 'sandbox', fetchImpl });

    await expect(
      client.getEntity({
        realmId: 'realm-1',
        accessToken: ACCESS_TOKEN,
        entityType: 'Invoice',
        qboId: 'missing',
      }),
    ).rejects.toThrow(QboNotFoundError);
  });

  it('maps 429 to a retryable QboApiError', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const client = createQboApiClient({ environment: 'sandbox', fetchImpl });

    await expect(
      client.getEntity({
        realmId: 'realm-1',
        accessToken: ACCESS_TOKEN,
        entityType: 'Invoice',
        qboId: '145',
      }),
    ).rejects.toMatchObject({ name: 'QboApiError', retryable: true });
  });

  it('maps 500 to a retryable QboApiError', async () => {
    const fetchImpl = vi.fn(async () => new Response('server error', { status: 500 }));
    const client = createQboApiClient({ environment: 'sandbox', fetchImpl });

    await expect(
      client.getEntity({
        realmId: 'realm-1',
        accessToken: ACCESS_TOKEN,
        entityType: 'Invoice',
        qboId: '145',
      }),
    ).rejects.toMatchObject({ name: 'QboApiError', retryable: true });
  });

  it('maps other non-2xx (e.g. 400) to a non-retryable QboApiError', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 }));
    const client = createQboApiClient({ environment: 'sandbox', fetchImpl });

    await expect(
      client.getEntity({
        realmId: 'realm-1',
        accessToken: ACCESS_TOKEN,
        entityType: 'Invoice',
        qboId: '145',
      }),
    ).rejects.toMatchObject({ name: 'QboApiError', retryable: false });
  });

  it('throws a non-retryable QboApiError on malformed JSON in a 200 response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('not-json{{{', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    const client = createQboApiClient({ environment: 'sandbox', fetchImpl });

    await expect(
      client.getEntity({
        realmId: 'realm-1',
        accessToken: ACCESS_TOKEN,
        entityType: 'Invoice',
        qboId: '145',
      }),
    ).rejects.toMatchObject({ name: 'QboApiError', retryable: false });
  });

  it('throws a non-retryable QboApiError when the 200 body is not an object (e.g. bare null)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, null));
    const client = createQboApiClient({ environment: 'sandbox', fetchImpl });

    await expect(
      client.getEntity({
        realmId: 'realm-1',
        accessToken: ACCESS_TOKEN,
        entityType: 'Invoice',
        qboId: '145',
      }),
    ).rejects.toMatchObject({ name: 'QboApiError', retryable: false });
  });
});
