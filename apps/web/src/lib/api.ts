// Typed fetch client for /api/*. Same-origin, httpOnly cookie auth: every
// call sends `credentials: 'include'` and the frontend never reads or sets
// the session cookie itself (see rules/payments-adjacent architecture-decisions.md
// "Frontend deployment" - no CORS, no token in JS).

export interface CurrentUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: initHeaders, ...restInit } = init ?? {};
  // Only declare a JSON Content-Type when we're actually sending a JSON body.
  // Fastify's default body parser rejects a request that declares
  // `Content-Type: application/json` but has an empty body with
  // `400 FST_ERR_CTP_EMPTY_JSON_BODY` before the route handler runs — so a
  // bodyless call (e.g. logout) must omit the header entirely.
  const hasBody = restInit.body !== undefined;

  const response = await fetch(path, {
    credentials: 'include',
    ...restInit,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...initHeaders,
    },
  });

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error body; leave `body` as null.
    }
    throw new ApiError(response.status, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function login(email: string, password: string): Promise<CurrentUser> {
  return request<CurrentUser>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<void> {
  return request<void>('/api/auth/logout', { method: 'POST' });
}

export function me(): Promise<CurrentUser> {
  return request<CurrentUser>('/api/auth/me');
}
