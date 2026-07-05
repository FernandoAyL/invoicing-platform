import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login, logout, me } from './api.ts';

// Regression coverage for the logout bug: the shared `request()` helper used
// to unconditionally send `Content-Type: application/json` on every call,
// including bodyless ones like `logout()`. Fastify's default JSON body
// parser rejects a request that declares that header with an empty body
// (`400 FST_ERR_CTP_EMPTY_JSON_BODY`) before the route handler runs, so
// logout never actually invalidated the session server-side. These tests
// assert the header (and body) are only sent when a JSON body is present.
describe('api request()', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits Content-Type and the body on a bodyless request (logout)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await logout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/logout');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.body).toBeUndefined();

    const headers = new Headers(init.headers);
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('omits Content-Type on a bodyless GET request (me)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: '1', email: 'admin@invoicing.test', role: 'admin' }), {
        status: 200,
      }),
    );

    await me();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();

    const headers = new Headers(init.headers);
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('sends Content-Type and the serialized JSON body on a request with a body (login)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: '1', email: 'admin@invoicing.test', role: 'admin' }), {
        status: 200,
      }),
    );

    await login('admin@invoicing.test', 'password123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(
      JSON.stringify({ email: 'admin@invoicing.test', password: 'password123' }),
    );

    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});
